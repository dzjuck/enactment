import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../src/artifacts/store.js';
import type { Change } from '../../src/diff/source-diff.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { acceptChanges } from '../../src/git/accept.js';
import { exportCommit } from '../../src/git/export.js';
import { idempotencyKey } from '../../src/git/idempotency.js';
import {
  buildManifest,
  loadManifest,
  validateManifest,
  writeManifest,
  type ApprovedInputs,
} from '../../src/plan/execution-manifest.js';
import { runPlan } from '../../src/run/coordinator.js';
import type { RunReport, StepExecutionOptions } from '../../src/run/orchestrator.js';
import { StateStore } from '../../src/state/store.js';
import type { FinalVerificationResult } from '../../src/verify/final.js';
import { createM2Repo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { tarWithAdditions } from '../helpers/tar.js';

const IMAGES: RuntimeImages = {
  agent: { role: 'agent', id: `sha256:${'a'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'b'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'c'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'d'.repeat(64)}` },
};

const BRANCH = 'ai-harness/demo-plan';

const dirs: string[] = [];
const repos: string[] = [];
const stores: StateStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(repos.splice(0).map((dir) => removeRepo(dir)));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-recovery-'));
  dirs.push(dir);
  return dir;
}

function planDocumentFor(stepIds: string[]): string {
  return [
    'version: 1',
    'id: demo-plan',
    'steps:',
    ...stepIds.flatMap((id) => [
      '  - type: task',
      `    id: ${id}`,
      `    observable_behavior: Do ${id}.`,
      '    implementation_paths:',
      `      - ${id}.txt`,
      '    verification:',
      '      commands:',
      '        - ["node", "--version"]',
    ]),
    'final_verification:',
    '  commands:',
    '    - ["node", "--version"]',
    '',
  ].join('\n');
}

interface Harness {
  repo: TargetRepo;
  approved: ApprovedInputs;
  store: StateStore;
  artifactsRoot: string;
  databasePath: string;
}

async function harness(stepIds = ['first-step', 'second-step']): Promise<Harness> {
  const repo = await createM2Repo();
  repos.push(repo.dir);

  const dir = await scratch();
  const planFile = join(dir, 'plan.yml');
  await writeFile(planFile, planDocumentFor(stepIds));

  const manifestPath = join(dir, 'execution-manifest.yml');
  await writeManifest(
    manifestPath,
    await buildManifest({
      planFile,
      manifestPath,
      repoPath: repo.dir,
      resolveImages: () => Promise.resolve(IMAGES),
    }),
  );

  const approved = await validateManifest(await loadManifest(manifestPath), {
    repoPath: repo.dir,
    resolveImages: () => Promise.resolve(IMAGES),
  });

  const databasePath = join(await scratch(), 'state.db');
  const store = StateStore.open(databasePath);
  stores.push(store);

  return { repo, approved, store, artifactsRoot: await scratch(), databasePath };
}

/** Reopen the database the way a restarted process would. */
function reopen(harness: Harness): StateStore {
  harness.store.close();
  const store = StateStore.open(harness.databasePath);
  stores.push(store);
  return store;
}

function change(path: string, content: string): Change {
  const bytes = Buffer.from(content);
  return {
    kind: 'modified',
    path,
    entry: { path, type: 'file', mode: 0o644, hash: 'unused', content: bytes },
  };
}

/** Accept a step's work for real, exactly as the executor's commit phase would. */
async function acceptFor(
  repo: TargetRepo,
  options: StepExecutionOptions,
): Promise<{ status: 'succeeded'; attempt: string; commit: string; branch: string }> {
  const accepted = await acceptChanges({
    repoPath: repo.dir,
    parentCommit: options.parentCommit,
    branchExists: options.branchExists,
    branch: options.branch,
    planId: options.planId,
    stepId: options.step.id,
    attempt: options.attempt,
    idempotencyKey: options.idempotencyKey,
    verificationStatus: 'pass',
    changes: [change(`${options.step.id}.txt`, `${options.step.id}\n`)],
  });

  return {
    status: 'succeeded',
    attempt: options.attempt,
    commit: accepted.commit,
    branch: accepted.branch,
  };
}

const passingFinal = (): Promise<FinalVerificationResult> =>
  Promise.resolve({
    status: 'pass',
    head: 'unused',
    commands: [],
    dependencyCacheKey: `sha256:${'f'.repeat(64)}`,
    exportHash: `sha256:${'0'.repeat(64)}`,
    runtime: {
      harness_version: '0.1.0',
      agent_image_id: IMAGES.agent.id,
      verifier_image_id: IMAGES.verifier.id,
      setup_image_id: IMAGES.setup.id,
      proxy_image_id: IMAGES.proxy.id,
    },
  });

describe('completed plans', () => {
  it('return the stored report without agents, verification, Git writes or new attempts', async () => {
    const h = await harness(['first-step']);
    const first = await runPlan(
      { approved: h.approved, store: h.store, artifactsRoot: h.artifactsRoot },
      { execute: (options) => acceptFor(h.repo, options), verifyFinal: passingFinal },
    );
    expect(first.state).toBe('completed');

    const refsBefore = await git(h.repo.dir, ['for-each-ref', '--format=%(refname) %(objectname)']);
    const store = reopen(h);
    let ran = false;

    const second = await runPlan(
      { approved: h.approved, store, artifactsRoot: h.artifactsRoot },
      {
        execute: () => {
          ran = true;
          return Promise.reject(new Error('should not run'));
        },
        verifyFinal: () => {
          ran = true;
          return Promise.reject(new Error('should not run'));
        },
      },
    );

    expect(ran).toBe(false);
    expect(second).toEqual(first);
    expect(await git(h.repo.dir, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(
      refsBefore,
    );

    const plan = store.planForManifest(h.repo.dir, h.approved.manifestHash);
    const step = store.steps(plan?.row ?? 0)[0];
    expect(store.attempts(step?.row ?? 0)).toHaveLength(1);
  });
});

describe('explicit retry after a recorded failure', () => {
  it('allocates a new attempt and leaves completed steps untouched', async () => {
    const h = await harness();
    const failed = await runPlan(
      { approved: h.approved, store: h.store, artifactsRoot: h.artifactsRoot },
      {
        execute: (options) =>
          options.step.id === 'second-step'
            ? Promise.resolve({
                status: 'failed' as const,
                attempt: options.attempt,
                category: 'agent_failed' as const,
                message: 'injected',
              })
            : acceptFor(h.repo, options),
        verifyFinal: passingFinal,
      },
    );
    expect(failed.state).toBe('failed');

    const store = reopen(h);
    const seen: StepExecutionOptions[] = [];

    const retried = await runPlan(
      { approved: h.approved, store, artifactsRoot: h.artifactsRoot },
      {
        execute: (options) => {
          seen.push(options);
          return acceptFor(h.repo, options);
        },
        verifyFinal: passingFinal,
      },
    );

    // Only the failed step reran, from the earlier step's accepted commit.
    expect(seen.map((options) => options.step.id)).toEqual(['second-step']);
    expect(seen[0]?.parentCommit).toBe(failed.steps[0]?.commit);
    expect(retried.state).toBe('completed');
    expect(retried.steps[0]?.commit).toBe(failed.steps[0]?.commit);

    const plan = store.planForManifest(h.repo.dir, h.approved.manifestHash);
    const second = store.steps(plan?.row ?? 0)[1];
    const attempts = store.attempts(second?.row ?? 0);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.state).toBe('failed');
    expect(attempts[1]?.attemptId).not.toBe(attempts[0]?.attemptId);
    expect(attempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);
  });
});

describe('a crashed attempt', () => {
  /** What a killed process leaves: a `running` row nothing ever finished. */
  async function crashedRunning(h: Harness): Promise<void> {
    const plan = h.store.registerPlan({
      planId: h.approved.plan.id,
      manifestHash: h.approved.manifestHash,
      planHash: h.approved.planHash,
      repoPath: h.repo.dir,
      branch: BRANCH,
      baseCommit: h.approved.baseCommit,
      stepIds: h.approved.plan.steps.map((step) => step.id),
    });
    const step = h.store.steps(plan.row)[0];
    if (step === undefined) throw new Error('expected a seeded step');

    const attempt = h.store.startAttempt({
      stepRow: step.row,
      attemptId: 'crashed-attempt',
      parentCommit: h.approved.baseCommit,
      artifactPath: join(h.artifactsRoot, 'demo-plan/steps/first-step/crashed-attempt/run-1'),
    });
    h.store.setAttemptPhase(attempt.row, 'implementation');
  }

  it('reuses its id, preserves run-1, allocates run-2 and reruns from the stored parent', async () => {
    const h = await harness(['first-step']);
    await crashedRunning(h);

    const attemptRoot = join(h.artifactsRoot, 'demo-plan/steps/first-step/crashed-attempt');
    await mkdir(join(attemptRoot, 'run-1'), { recursive: true });
    await writeFile(join(attemptRoot, 'run-1', 'prompt.txt'), 'evidence from the killed run\n');

    const store = reopen(h);
    const seen: StepExecutionOptions[] = [];

    const report = await runPlan(
      { approved: h.approved, store, artifactsRoot: h.artifactsRoot },
      {
        execute: (options) => {
          seen.push(options);
          return acceptFor(h.repo, options);
        },
        verifyFinal: passingFinal,
      },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.attempt).toBe('crashed-attempt');
    expect(seen[0]?.parentCommit).toBe(h.approved.baseCommit);
    expect(seen[0]?.artifactDir).toBe(join(attemptRoot, 'run-2'));
    expect(report.state).toBe('completed');

    // The killed run's evidence is still there beside the recovery run's.
    expect((await readdir(attemptRoot)).sort()).toEqual(['run-1', 'run-2']);

    const plan = store.planForManifest(h.repo.dir, h.approved.manifestHash);
    const attempts = store.attempts(store.steps(plan?.row ?? 0)[0]?.row ?? 0);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.runs).toBe(2);
  });
});

describe('an attempt left in accepting', () => {
  /**
   * Registers a plan, drives one step to a real commit, then rewinds the database to the
   * moment just before the acceptance transaction — which is exactly what a process killed
   * between the commit and the database write leaves behind.
   */
  async function acceptingWithCommit(h: Harness): Promise<{ commit: string; key: string }> {
    const plan = h.store.registerPlan({
      planId: h.approved.plan.id,
      manifestHash: h.approved.manifestHash,
      planHash: h.approved.planHash,
      repoPath: h.repo.dir,
      branch: BRANCH,
      baseCommit: h.approved.baseCommit,
      stepIds: h.approved.plan.steps.map((step) => step.id),
    });
    const step = h.store.steps(plan.row)[0];
    if (step === undefined) throw new Error('expected a seeded step');

    const key = idempotencyKey({
      manifestHash: h.approved.manifestHash,
      planId: 'demo-plan',
      stepId: 'first-step',
      attempt: 'accepting-attempt',
      parentCommit: h.approved.baseCommit,
    });

    const attempt = h.store.startAttempt({
      stepRow: step.row,
      attemptId: 'accepting-attempt',
      parentCommit: h.approved.baseCommit,
      artifactPath: join(h.artifactsRoot, 'demo-plan/steps/first-step/accepting-attempt/run-1'),
    });
    h.store.setAttemptCandidate(attempt.row, `sha256:${'e'.repeat(64)}`, key);
    h.store.setAttemptState(attempt.row, 'accepting');

    const accepted = await acceptChanges({
      repoPath: h.repo.dir,
      parentCommit: h.approved.baseCommit,
      branchExists: false,
      branch: BRANCH,
      planId: 'demo-plan',
      stepId: 'first-step',
      attempt: 'accepting-attempt',
      idempotencyKey: key,
      verificationStatus: 'pass',
      changes: [change('first-step.txt', 'first-step\n')],
    });

    return { commit: accepted.commit, key };
  }

  it('completes the database transition from a matching commit, without agent or verifier', async () => {
    const h = await harness(['first-step']);
    const { commit } = await acceptingWithCommit(h);

    const store = reopen(h);
    let ran = false;

    const report = await runPlan(
      { approved: h.approved, store, artifactsRoot: h.artifactsRoot },
      {
        execute: () => {
          ran = true;
          return Promise.reject(new Error('should not run'));
        },
        verifyFinal: passingFinal,
      },
    );

    expect(ran).toBe(false);
    expect(report.state).toBe('completed');
    expect(report.head).toBe(commit);
    expect(report.steps[0]).toMatchObject({ status: 'completed', commit });
    expect(await git(h.repo.dir, ['rev-list', '--count', BRANCH])).toBe('2');
  });

  it('reruns only Git acceptance when no commit carries the key', async () => {
    const h = await harness(['first-step']);
    const plan = h.store.registerPlan({
      planId: h.approved.plan.id,
      manifestHash: h.approved.manifestHash,
      planHash: h.approved.planHash,
      repoPath: h.repo.dir,
      branch: BRANCH,
      baseCommit: h.approved.baseCommit,
      stepIds: ['first-step'],
    });
    const step = h.store.steps(plan.row)[0];
    if (step === undefined) throw new Error('expected a seeded step');

    // The verified candidate is in the plan snapshot store; no commit was ever made.
    const snapshots = new ArtifactStore(join(h.artifactsRoot, 'demo-plan', 'snapshots'));
    const candidate = await snapshots.put(
      await tarWithAdditions((await exportCommit(h.repo.dir, h.approved.baseCommit)).tar, {
        'first-step.txt': 'first-step\n',
      }),
    );

    const key = idempotencyKey({
      manifestHash: h.approved.manifestHash,
      planId: 'demo-plan',
      stepId: 'first-step',
      attempt: 'accepting-attempt',
      parentCommit: h.approved.baseCommit,
    });
    const attempt = h.store.startAttempt({
      stepRow: step.row,
      attemptId: 'accepting-attempt',
      parentCommit: h.approved.baseCommit,
      artifactPath: join(h.artifactsRoot, 'demo-plan/steps/first-step/accepting-attempt/run-1'),
    });
    h.store.setAttemptCandidate(attempt.row, candidate.hash, key);
    h.store.setAttemptState(attempt.row, 'accepting');

    const store = reopen(h);
    let ran = false;

    const report = await runPlan(
      { approved: h.approved, store, artifactsRoot: h.artifactsRoot },
      {
        execute: () => {
          ran = true;
          return Promise.reject(new Error('should not run'));
        },
        verifyFinal: passingFinal,
      },
    );

    expect(ran).toBe(false);
    expect(report.state).toBe('completed');
    expect(await git(h.repo.dir, ['rev-list', '--count', BRANCH])).toBe('2');
    expect(await git(h.repo.dir, ['show', `${report.head ?? ''}:first-step.txt`])).toBe(
      'first-step',
    );

    const message = await git(h.repo.dir, ['log', '-1', '--format=%B', report.head ?? '']);
    expect(message).toContain(`AI-Harness-Idempotency-Key: ${key}`);
  });
});

describe('divergent state', () => {
  it('fails closed when the plan branch no longer matches the stored head', async () => {
    const h = await harness();
    const first = await runPlan(
      { approved: h.approved, store: h.store, artifactsRoot: h.artifactsRoot },
      {
        execute: (options) =>
          options.step.id === 'second-step'
            ? Promise.resolve({
                status: 'failed' as const,
                attempt: options.attempt,
                category: 'agent_failed' as const,
                message: 'injected',
              })
            : acceptFor(h.repo, options),
        verifyFinal: passingFinal,
      },
    );
    expect(first.steps[0]?.status).toBe('completed');

    // Someone moved the plan branch behind the harness's back.
    await git(h.repo.dir, ['update-ref', `refs/heads/${BRANCH}`, h.approved.baseCommit]);

    const store = reopen(h);
    let ran = false;
    const report = await runPlan(
      { approved: h.approved, store, artifactsRoot: h.artifactsRoot },
      {
        execute: () => {
          ran = true;
          return Promise.reject(new Error('should not run'));
        },
        verifyFinal: passingFinal,
      },
    );

    expect(ran).toBe(false);
    expect(report.state).toBe('failed');
    expect(report.failure?.message).toMatch(/head|ref|diverg/i);
    // Neither Git nor the completion state changed.
    expect(await git(h.repo.dir, ['rev-parse', BRANCH])).toBe(h.approved.baseCommit);
    expect(report.steps[0]?.status).toBe('completed');
    expect(report.steps[0]?.commit).toBe(first.steps[0]?.commit);
  });
});

describe('final verification recovery', () => {
  it('reruns only final verification, never a completed step', async () => {
    const h = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];
    const execute = (options: StepExecutionOptions): Promise<RunReport> => {
      seen.push(options);
      return acceptFor(h.repo, options);
    };

    const failed = await runPlan(
      { approved: h.approved, store: h.store, artifactsRoot: h.artifactsRoot },
      {
        execute,
        verifyFinal: async (options) => ({
          ...(await passingFinal()),
          status: 'fail' as const,
          head: options.head,
        }),
      },
    );
    expect(failed.state).toBe('failed');
    expect(seen).toHaveLength(1);

    const store = reopen(h);
    const finalDirs: string[] = [];

    const passed = await runPlan(
      { approved: h.approved, store, artifactsRoot: h.artifactsRoot },
      {
        execute,
        verifyFinal: async (options) => {
          finalDirs.push(options.artifactDir);
          return { ...(await passingFinal()), head: options.head };
        },
      },
    );

    expect(seen).toHaveLength(1);
    expect(passed.state).toBe('completed');
    expect(passed.head).toBe(failed.head);
    // A second final-verification run, in its own directory beside the failed one.
    expect(finalDirs).toHaveLength(1);
    expect(finalDirs[0]).toBe(join(h.artifactsRoot, 'demo-plan', 'final', 'run-2'));
  });
});

describe('startup snapshot reconciliation', () => {
  it('keeps only candidates an accepting attempt still needs and removes crash leftovers', async () => {
    const h = await harness(['first-step', 'second-step']);
    const snapshots = new ArtifactStore(join(h.artifactsRoot, 'demo-plan', 'snapshots'));

    const plan = h.store.registerPlan({
      planId: h.approved.plan.id,
      manifestHash: h.approved.manifestHash,
      planHash: h.approved.planHash,
      repoPath: h.repo.dir,
      branch: BRANCH,
      baseCommit: h.approved.baseCommit,
      stepIds: ['first-step', 'second-step'],
    });
    const step = h.store.steps(plan.row)[0];
    if (step === undefined) throw new Error('expected a seeded step');

    const key = idempotencyKey({
      manifestHash: h.approved.manifestHash,
      planId: 'demo-plan',
      stepId: 'first-step',
      attempt: 'accepting-attempt',
      parentCommit: h.approved.baseCommit,
    });
    const candidate = await snapshots.put(
      await tarWithAdditions((await exportCommit(h.repo.dir, h.approved.baseCommit)).tar, {
        'first-step.txt': 'first-step\n',
      }),
    );
    // Leftovers a killed process never cleaned up.
    await snapshots.put(Buffer.from('crash leftover one'));
    await snapshots.put(Buffer.from('crash leftover two'));

    const attempt = h.store.startAttempt({
      stepRow: step.row,
      attemptId: 'accepting-attempt',
      parentCommit: h.approved.baseCommit,
      artifactPath: join(h.artifactsRoot, 'unused'),
    });
    h.store.setAttemptCandidate(attempt.row, candidate.hash, key);
    h.store.setAttemptState(attempt.row, 'accepting');

    expect(await readdir(join(h.artifactsRoot, 'demo-plan', 'snapshots'))).toHaveLength(3);

    const store = reopen(h);
    await runPlan(
      { approved: h.approved, store, artifactsRoot: h.artifactsRoot },
      {
        execute: (options) => acceptFor(h.repo, options),
        verifyFinal: passingFinal,
      },
    );

    // The candidate was consumed by acceptance recovery and nothing else survived.
    expect(await readdir(join(h.artifactsRoot, 'demo-plan', 'snapshots'))).toEqual([]);
  });
});
