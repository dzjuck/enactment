import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SCHEMA_VERSION,
  StateStore,
  StateStoreError,
  type RegisterPlanInput,
} from '../../src/state/store.js';

const dirs: string[] = [];
const stores: StateStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-state-'));
  dirs.push(dir);
  return join(dir, 'state.db');
}

function open(path: string): StateStore {
  const store = StateStore.open(path);
  stores.push(store);
  return store;
}

const COMMIT = (fill: string): string => fill.repeat(40).slice(0, 40);

function registration(overrides: Partial<RegisterPlanInput> = {}): RegisterPlanInput {
  return {
    planId: 'slugify-plan',
    manifestHash: `sha256:${'1'.repeat(64)}`,
    planHash: `sha256:${'2'.repeat(64)}`,
    repoPath: '/repo',
    branch: 'ai-harness/slugify-plan',
    baseCommit: COMMIT('a'),
    stepIds: ['first-step', 'second-step'],
    ...overrides,
  };
}

describe('state store schema', () => {
  it('creates the schema with foreign keys, WAL and its supported version', async () => {
    const path = await databasePath();
    open(path).close();

    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
      expect(raw.prepare('SELECT version FROM schema_version').all()).toEqual([
        { version: 2 },
      ]);
      expect(SCHEMA_VERSION).toBe(2);
      const attemptColumns = raw.prepare('PRAGMA table_info(attempts)').all() as {
        name: string;
      }[];
      expect(attemptColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['profile_id', 'retry_of_attempt_row']),
      );
      expect(attemptColumns.map((column) => column.name)).not.toContain('kind');
    } finally {
      raw.close();
    }

    const reopened = open(path);
    expect(reopened.foreignKeysEnabled()).toBe(true);
  });

  it('fails with an actionable error on an unknown schema version', async () => {
    const path = await databasePath();
    open(path).close();

    const raw = new DatabaseSync(path);
    raw.exec('UPDATE schema_version SET version = 1');
    raw.close();

    expect(() => StateStore.open(path)).toThrow(StateStoreError);
    expect(() => StateStore.open(path)).toThrow(/1.*expects.*2.*fresh state database|schema version/i);
  });

  it('has no migration framework', async () => {
    const files = await readdir(join(process.cwd(), 'src'), { recursive: true });
    expect(files.filter((name) => /migrat/i.test(name))).toEqual([]);
  });
});

describe('plan registration', () => {
  it('creates the plan and its ordered pending steps in one transaction', async () => {
    const store = open(await databasePath());

    const plan = store.registerPlan(registration());

    expect(plan.state).toBe('approved');
    expect(plan.headCommit).toBeUndefined();
    expect(store.steps(plan.row).map((step) => [step.position, step.stepId, step.status])).toEqual([
      [0, 'first-step', 'pending'],
      [1, 'second-step', 'pending'],
    ]);
  });

  it('returns the same plan when the identical manifest is registered again', async () => {
    const store = open(await databasePath());

    const first = store.registerPlan(registration());
    store.setPlanState(first.row, 'running');
    const second = store.registerPlan(registration());

    expect(second.row).toBe(first.row);
    expect(second.state).toBe('running');
    expect(store.steps(second.row)).toHaveLength(2);
  });

  it('canonicalizes the repository path before deciding ownership', async () => {
    const store = open(await databasePath());
    const dir = await mkdtemp(join(tmpdir(), 'harness-repo-'));
    dirs.push(dir);

    const first = store.registerPlan(registration({ repoPath: dir }));
    const second = store.registerPlan(registration({ repoPath: join(dir, '.', '') }));

    expect(second.row).toBe(first.row);
  });

  it.each(['approved', 'running', 'failed'] as const)(
    'refuses a different manifest while a %s plan owns the repository',
    async (state) => {
      const store = open(await databasePath());
      const plan = store.registerPlan(registration());
      store.setPlanState(plan.row, state);

      expect(() =>
        store.registerPlan(registration({ manifestHash: `sha256:${'9'.repeat(64)}` })),
      ).toThrow(StateStoreError);
    },
  );

  it.each(['completed', 'cancelled'] as const)(
    'lets a new manifest take the repository once the previous plan is %s',
    async (state) => {
      const store = open(await databasePath());
      const plan = store.registerPlan(registration());
      store.setPlanState(plan.row, state);

      const next = store.registerPlan(registration({ manifestHash: `sha256:${'9'.repeat(64)}` }));

      expect(next.row).not.toBe(plan.row);
    },
  );
});

describe('cancellation', () => {
  it('requires the exact active manifest and preserves the plan history', async () => {
    const store = open(await databasePath());
    const plan = store.registerPlan(registration());

    expect(() => store.cancelPlan('/repo', `sha256:${'9'.repeat(64)}`)).toThrow(StateStoreError);

    store.cancelPlan('/repo', registration().manifestHash);

    expect(store.planByRow(plan.row)?.state).toBe('cancelled');
    expect(store.steps(plan.row)).toHaveLength(2);
    expect(
      store.registerPlan(registration({ manifestHash: `sha256:${'9'.repeat(64)}` })).row,
    ).not.toBe(plan.row);
  });
});

describe('attempts', () => {
  function seed(store: StateStore) {
    const plan = store.registerPlan(registration());
    const step = store.steps(plan.row)[0];
    if (step === undefined) throw new Error('expected a seeded step');
    return { plan, step };
  }

  it('persists every recovery state, and phase advances as a diagnostic', async () => {
    const path = await databasePath();
    const store = open(path);
    const { step } = seed(store);

    const attempt = store.startAttempt({
      stepRow: step.row,
      attemptId: 'attempt-1',
      profileId: 'codex-fast',
      parentCommit: COMMIT('a'),
      artifactPath: '/artifacts/steps/first-step/attempt-1/run-1',
    });

    expect(attempt.state).toBe('running');
    expect(attempt.ordinal).toBe(1);

    for (const phase of ['baseline', 'tests', 'red', 'implementation', 'green'] as const) {
      store.setAttemptPhase(attempt.row, phase);
    }
    store.setAttemptCandidate(attempt.row, `sha256:${'c'.repeat(64)}`, `sha256:${'k'.repeat(64)}`);
    store.setAttemptState(attempt.row, 'accepting');
    store.close();

    const reopened = open(path);
    const persisted = reopened.attemptByRow(attempt.row);
    expect(persisted).toMatchObject({
      state: 'accepting',
      phase: 'green',
      attemptId: 'attempt-1',
      profileId: 'codex-fast',
      kind: 'normal',
      candidateSnapshot: `sha256:${'c'.repeat(64)}`,
      idempotencyKey: `sha256:${'k'.repeat(64)}`,
      artifactPath: '/artifacts/steps/first-step/attempt-1/run-1',
      parentCommit: COMMIT('a'),
    });
  });

  it('records a failure with its message and never reuses the ordinal or ID', async () => {
    const store = open(await databasePath());
    const { plan, step } = seed(store);

    const first = store.startAttempt({
      stepRow: step.row,
      attemptId: 'attempt-1',
      profileId: 'codex-fast',
      parentCommit: COMMIT('a'),
      artifactPath: '/artifacts/1',
    });
    store.failPlan({
      planRow: plan.row,
      attemptRow: first.row,
      failure: 'red_invalid: nothing failed',
    });

    expect(store.attemptByRow(first.row)).toMatchObject({
      state: 'failed',
      failure: 'red_invalid: nothing failed',
    });

    const second = store.startAttempt({
      stepRow: step.row,
      attemptId: 'attempt-2',
      profileId: 'claude-deep',
      retryOfAttemptRow: first.row,
      parentCommit: COMMIT('a'),
      artifactPath: '/artifacts/2',
    });
    expect(second.ordinal).toBe(2);
    expect(second).toMatchObject({
      profileId: 'claude-deep',
      retryOfAttemptRow: first.row,
      kind: 'stronger',
    });

    expect(() =>
      store.startAttempt({
        stepRow: step.row,
        attemptId: 'attempt-1',
        profileId: 'codex-fast',
        parentCommit: COMMIT('a'),
        artifactPath: '/artifacts/3',
      }),
    ).toThrow();
  });

  it('completes the attempt, the step and the plan head as one transaction', async () => {
    const store = open(await databasePath());
    const { plan, step } = seed(store);
    const attempt = store.startAttempt({
      stepRow: step.row,
      attemptId: 'attempt-1',
      profileId: 'codex-fast',
      parentCommit: COMMIT('a'),
      artifactPath: '/artifacts/1',
    });
    store.setAttemptState(attempt.row, 'accepting');

    store.completeAcceptance({
      planRow: plan.row,
      stepRow: step.row,
      attemptRow: attempt.row,
      commit: COMMIT('b'),
    });

    expect(store.attemptByRow(attempt.row)).toMatchObject({
      state: 'completed',
      commit: COMMIT('b'),
    });
    expect(store.steps(plan.row)[0]).toMatchObject({ status: 'completed', commit: COMMIT('b') });
    expect(store.planByRow(plan.row)?.headCommit).toBe(COMMIT('b'));
  });

  it('rolls the whole acceptance back when any part of it fails', async () => {
    const store = open(await databasePath());
    const { plan, step } = seed(store);
    const attempt = store.startAttempt({
      stepRow: step.row,
      attemptId: 'attempt-1',
      profileId: 'codex-fast',
      parentCommit: COMMIT('a'),
      artifactPath: '/artifacts/1',
    });
    store.setAttemptState(attempt.row, 'accepting');

    // The plan head is written last and is constrained to a full commit SHA, so a malformed
    // commit fails after the attempt and step rows have already been updated.
    expect(() =>
      store.completeAcceptance({
        planRow: plan.row,
        stepRow: step.row,
        attemptRow: attempt.row,
        commit: 'not-a-commit',
      }),
    ).toThrow();

    expect(store.attemptByRow(attempt.row)?.state).toBe('accepting');
    expect(store.steps(plan.row)[0]?.status).toBe('pending');
    expect(store.planByRow(plan.row)?.headCommit).toBeUndefined();
  });

  it('selects the next pending step in plan order and skips completed ones', async () => {
    const store = open(await databasePath());
    const { plan, step } = seed(store);

    expect(store.nextPendingStep(plan.row)?.stepId).toBe('first-step');

    const attempt = store.startAttempt({
      stepRow: step.row,
      attemptId: 'attempt-1',
      profileId: 'codex-fast',
      parentCommit: COMMIT('a'),
      artifactPath: '/artifacts/1',
    });
    store.completeAcceptance({
      planRow: plan.row,
      stepRow: step.row,
      attemptRow: attempt.row,
      commit: COMMIT('b'),
    });

    expect(store.nextPendingStep(plan.row)?.stepId).toBe('second-step');
  });

  it('fails the attempt and plan in one transaction', async () => {
    const store = open(await databasePath());
    const { plan, step } = seed(store);
    store.setPlanState(plan.row, 'running');
    const attempt = store.startAttempt({
      stepRow: step.row,
      attemptId: 'attempt-1',
      profileId: 'codex-fast',
      parentCommit: COMMIT('a'),
      artifactPath: '/artifacts/1',
    });

    store.failPlan({
      planRow: plan.row,
      attemptRow: attempt.row,
      failure: 'agent_failed: injected',
    });

    expect(store.attemptByRow(attempt.row)).toMatchObject({
      state: 'failed',
      failure: 'agent_failed: injected',
    });
    expect(store.planByRow(plan.row)?.state).toBe('failed');
  });

  it('rolls back both terminal writes when the plan update fails', async () => {
    const store = open(await databasePath());
    const { plan, step } = seed(store);
    store.setPlanState(plan.row, 'running');
    const attempt = store.startAttempt({
      stepRow: step.row,
      attemptId: 'attempt-1',
      profileId: 'codex-fast',
      parentCommit: COMMIT('a'),
      artifactPath: '/artifacts/1',
    });

    expect(() =>
      store.failPlan({
        planRow: -1,
        attemptRow: attempt.row,
        failure: 'agent_failed: injected',
      }),
    ).toThrow(/plan row/i);

    expect(store.attemptByRow(attempt.row)?.state).toBe('running');
    expect(store.attemptByRow(attempt.row)?.failure).toBeUndefined();
    expect(store.planByRow(plan.row)?.state).toBe('running');
  });
});
