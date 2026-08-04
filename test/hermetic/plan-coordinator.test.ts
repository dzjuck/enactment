import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArtifactStore } from '../../src/artifacts/store.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import {
  buildManifest,
  loadManifest,
  validateManifest,
  writeManifest,
  type ApprovedInputs,
} from '../../src/plan/execution-manifest.js';
import { pruneSnapshots, runPlan, type PlanReport } from '../../src/run/coordinator.js';
import type { DiagnosisResult } from '../../src/run/diagnosis.js';
import type { StepExecutionOptions, RunReport } from '../../src/run/orchestrator.js';
import { PROFILES } from '../../src/routing/profiles.js';
import { StateStore } from '../../src/state/store.js';
import type { FinalVerificationResult } from '../../src/verify/final.js';
import { commitAll, createM2Repo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';

const IMAGES: RuntimeImages = {
  codex: { role: 'codex', id: `sha256:${'a'.repeat(64)}` },
  claude: { role: 'claude', id: `sha256:${'e'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'b'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'c'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'d'.repeat(64)}` },
};

const dirs: string[] = [];
const repos: string[] = [];
const stores: StateStore[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(repos.splice(0).map((dir) => removeRepo(dir)));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-coordinator-'));
  dirs.push(dir);
  return dir;
}

function step(id: string, complexity = 'low'): string[] {
  return [
    `  - type: task`,
    `    complexity: ${complexity}`,
    `    id: ${id}`,
    `    observable_behavior: Do ${id}.`,
    `    implementation_paths:`,
    `      - src/${id}.js`,
    `    verification:`,
    `      commands:`,
    `        - ["node", "--version"]`,
  ];
}

function planDocumentFor(
  stepIds: string[],
  complexities: Record<string, string> = {},
): string {
  return [
    'version: 1',
    'id: demo-plan',
    'steps:',
    ...stepIds.flatMap((id) => step(id, complexities[id])),
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
}

async function harness(
  stepIds = ['first-step', 'second-step'],
  complexities: Record<string, string> = {},
): Promise<Harness> {
  const repo = await createM2Repo();
  repos.push(repo.dir);

  const dir = await scratch();
  const planFile = join(dir, 'plan.yml');
  await writeFile(planFile, planDocumentFor(stepIds, complexities));

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

  const store = StateStore.open(join(await scratch(), 'state.db'));
  stores.push(store);

  return { repo, approved, store, artifactsRoot: await scratch() };
}

/** A fake executor that commits the step's file for real, so Git state stays truthful. */
function committingExecutor(
  repo: TargetRepo,
  seen: StepExecutionOptions[],
): (options: StepExecutionOptions) => Promise<RunReport> {
  return async (options) => {
    seen.push(options);

    await writeFile(join(repo.dir, `${options.step.id}.txt`), `${options.step.id}\n`);
    const commit = await commitAll(repo.dir, `${options.step.id}: fake acceptance`);
    await git(repo.dir, [
      'update-ref',
      `refs/heads/${options.branch}`,
      commit,
      options.branchExists ? options.parentCommit : '',
    ]);
    await git(repo.dir, ['reset', '--hard', options.parentCommit]);

    await options.onEvent?.({ kind: 'candidate', snapshot: `sha256:${'e'.repeat(64)}` });
    await options.onEvent?.({ kind: 'accepting' });

    return { status: 'succeeded', attempt: options.attempt, commit, branch: options.branch };
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
      codex_image_id: IMAGES.codex.id,
      claude_image_id: IMAGES.claude.id,
      verifier_image_id: IMAGES.verifier.id,
      setup_image_id: IMAGES.setup.id,
      proxy_image_id: IMAGES.proxy.id,
    },
  });

describe('plan progression', () => {
  it('resolves each complexity once and hands the selected profile to the executor', async () => {
    const ids = ['low-step', 'medium-step', 'high-step'];
    const { repo, approved, store, artifactsRoot } = await harness(ids, {
      'low-step': 'low',
      'medium-step': 'medium',
      'high-step': 'high',
    });
    const seen: StepExecutionOptions[] = [];

    await runPlan(
      { approved, store, artifactsRoot },
      { execute: committingExecutor(repo, seen), verifyFinal: passingFinal },
    );

    expect(seen.map((options) => options.profile)).toEqual([
      PROFILES['codex-fast'],
      PROFILES['claude-balanced'],
      PROFILES['codex-deep'],
    ]);
  });

  it('registers the manifest, runs every step in order, and completes the plan', async () => {
    const { repo, approved, store, artifactsRoot } = await harness();
    const seen: StepExecutionOptions[] = [];
    let finalHead: string | undefined;

    const report = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: committingExecutor(repo, seen),
        verifyFinal: (options) => {
          finalHead = options.head;
          return passingFinal();
        },
      },
    );

    expect(seen.map((options) => options.step.id)).toEqual(['first-step', 'second-step']);
    expect(report.state).toBe('completed');
    expect(report.branch).toBe('ai-harness/demo-plan');
    expect(report.steps.map((entry) => entry.status)).toEqual(['completed', 'completed']);
    expect(finalHead).toBe(report.head);
    expect(await git(repo.dir, ['rev-parse', 'ai-harness/demo-plan'])).toBe(report.head);
  });

  it('hands each step the previous step accepted commit, never the checked-out head', async () => {
    const { repo, approved, store, artifactsRoot } = await harness();
    const seen: StepExecutionOptions[] = [];

    // A user commit on the checked-out branch: a parent taken from HEAD would pick this up.
    await writeFile(join(repo.dir, 'user.txt'), 'user work\n');
    await commitAll(repo.dir, 'unrelated user commit');

    const report = await runPlan(
      { approved, store, artifactsRoot },
      { execute: committingExecutor(repo, seen), verifyFinal: passingFinal },
    );

    expect(seen[0]?.parentCommit).toBe(approved.baseCommit);
    expect(seen[0]?.branchExists).toBe(false);
    expect(seen[1]?.parentCommit).toBe(report.steps[0]?.commit);
    expect(seen[1]?.branchExists).toBe(true);
  });

  it('commits each step transaction before the next step starts', async () => {
    const { repo, approved, store, artifactsRoot } = await harness();
    const seen: StepExecutionOptions[] = [];
    const commit = committingExecutor(repo, seen);
    const observed: (string | undefined)[] = [];

    await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: async (options) => {
          // What the database says at the moment this step is invoked.
          const plan = store.activePlanForRepo(repo.dir);
          observed.push(plan?.headCommit);
          return commit(options);
        },
        verifyFinal: passingFinal,
      },
    );

    expect(observed[0]).toBeUndefined();
    expect(observed[1]).toBe(seen[1]?.parentCommit);
  });

  it('selects the next pending step and never reruns a completed one', async () => {
    const { repo, approved, store, artifactsRoot } = await harness([
      'first-step',
      'second-step',
      'third-step',
    ]);
    const seen: StepExecutionOptions[] = [];

    await runPlan(
      { approved, store, artifactsRoot },
      { execute: committingExecutor(repo, seen), verifyFinal: passingFinal },
    );

    expect(seen.map((options) => options.step.id)).toEqual([
      'first-step',
      'second-step',
      'third-step',
    ]);
  });
});

describe('plan failure', () => {
  it('has no split attempt-failure and plan-failure write path', async () => {
    const coordinator = await readFile(join(process.cwd(), 'src/run/coordinator.ts'), 'utf8');

    expect(coordinator).not.toContain('.failAttempt(');
    expect(coordinator).toContain('.failPlan(');
  });

  it('stops at the failing step, starts no later step and no final verification', async () => {
    const { repo, approved, store, artifactsRoot } = await harness();
    const seen: StepExecutionOptions[] = [];
    const commit = committingExecutor(repo, seen);
    let finalRan = false;

    const report = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: (options) =>
          options.step.id === 'second-step'
            ? Promise.resolve({
                status: 'failed' as const,
                attempt: options.attempt,
                failedPhase: 'green' as const,
                category: 'verification_failed' as const,
                message: 'injected failure',
              })
            : commit(options),
        verifyFinal: () => {
          finalRan = true;
          return passingFinal();
        },
      },
    );

    expect(finalRan).toBe(false);
    expect(report.state).toBe('failed');
    expect(report.failure).toMatchObject({
      step: 'second-step',
      category: 'verification_failed',
      message: 'injected failure',
    });

    // The earlier step's acceptance is untouched, and the branch still holds it.
    expect(report.steps[0]?.status).toBe('completed');
    expect(report.steps[1]?.status).toBe('pending');
    expect(await git(repo.dir, ['rev-parse', 'ai-harness/demo-plan'])).toBe(report.steps[0]?.commit);

    const plan = store.activePlanForRepo(repo.dir);
    expect(plan?.state).toBe('failed');
    expect(store.attempts(store.steps(plan?.row ?? 0)[1]?.row ?? 0)[0]?.state).toBe('failed');
  });

  it('fails the plan when final verification fails, keeping the branch', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];

    const report = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: committingExecutor(repo, seen),
        verifyFinal: async (options) => ({
          ...(await passingFinal()),
          status: 'fail' as const,
          head: options.head,
        }),
      },
    );

    expect(report.state).toBe('failed');
    expect(report.finalVerification?.status).toBe('fail');
    expect(report.steps[0]?.status).toBe('completed');
    expect(await git(repo.dir, ['rev-parse', 'ai-harness/demo-plan'])).toBe(report.head);
  });

  it('refuses to start a plan whose branch already exists, before any step runs', async () => {
    const { repo, approved, store, artifactsRoot } = await harness();
    await git(repo.dir, ['branch', 'ai-harness/demo-plan', repo.commit]);
    let started = false;

    const report = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: () => {
          started = true;
          return Promise.reject(new Error('should not run'));
        },
        verifyFinal: passingFinal,
      },
    );

    expect(started).toBe(false);
    expect(report.state).toBe('failed');
    expect(report.failure?.message).toMatch(/ai-harness\/demo-plan/);
  });
});

describe('stronger retry', () => {
  const diagnosed = (): Promise<DiagnosisResult> =>
    Promise.resolve({ status: 'completed', text: 'Check the allowed source scope.' });

  it('diagnoses once and runs one stronger child from a clean attempt', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];
    const accept = committingExecutor(repo, seen);
    let diagnoses = 0;

    const report = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: async (options) => {
          seen.push(options);
          if (seen.length === 1) {
            return {
              status: 'failed',
              attempt: options.attempt,
              failedPhase: 'agent',
              category: 'invalid_change',
              message: 'outside scope',
            };
          }
          seen.pop();
          return accept(options);
        },
        diagnose: async () => {
          diagnoses += 1;
          return diagnosed();
        },
        verifyFinal: passingFinal,
      },
    );

    expect(diagnoses).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen.map((options) => options.profile)).toEqual([
      PROFILES['codex-fast'],
      PROFILES['claude-deep'],
    ]);
    expect(seen[1]?.attempt).not.toBe(seen[0]?.attempt);
    expect(seen[1]?.parentCommit).toBe(seen[0]?.parentCommit);
    expect(seen[1]?.artifactDir).not.toBe(seen[0]?.artifactDir);
    expect(seen[1]?.advisoryContext).toContain('Check the allowed source scope.');
    expect(seen[1]?.advisoryContext).toContain('invalid_change');
    expect(report.state).toBe('completed');
    expect(report.steps[0]?.attempts).toMatchObject([
      { kind: 'normal', profile: 'codex-fast', state: 'failed' },
      { kind: 'stronger', profile: 'claude-deep', state: 'completed' },
    ]);
  });

  it.each(['failed', 'timeout'] as const)(
    'keeps the original failure primary when diagnosis is %s',
    async (diagnosisStatus) => {
      const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
      const seen: StepExecutionOptions[] = [];
      const accept = committingExecutor(repo, seen);

      const report = await runPlan(
        { approved, store, artifactsRoot },
        {
          execute: async (options) => {
            seen.push(options);
            if (seen.length === 1) {
              return {
                status: 'failed',
                attempt: options.attempt,
                failedPhase: 'green',
                category: 'verification_failed',
                message: 'expected test failed',
              };
            }
            seen.pop();
            return accept(options);
          },
          diagnose: () =>
            Promise.resolve({ status: diagnosisStatus, text: '', error: 'diagnosis unavailable' }),
          verifyFinal: passingFinal,
        },
      );

      expect(report.state).toBe('completed');
      expect(seen).toHaveLength(2);
      expect(seen[1]?.advisoryContext).toContain('verification_failed');
      expect(seen[1]?.advisoryContext).toContain('expected test failed');
      expect(seen[1]?.advisoryContext).not.toContain('diagnosis unavailable');
      expect(report.steps[0]?.attempts[0]?.diagnosis).toMatchObject({ status: diagnosisStatus });
    },
  );

  it.each([
    'provider_error',
    'agent_timeout',
    'test_contract_disputed',
    'baseline_failed',
    'setup_failed',
    'provider_connectivity_timeout',
    'internal_error',
  ] as const)('does not diagnose or retry %s', async (category) => {
    const { approved, store, artifactsRoot } = await harness(['first-step']);
    let executions = 0;
    let diagnoses = 0;

    const report = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: (options) => {
          executions += 1;
          return Promise.resolve({
            status: 'failed',
            attempt: options.attempt,
            category,
            message: 'terminal',
          });
        },
        diagnose: () => {
          diagnoses += 1;
          return diagnosed();
        },
        verifyFinal: passingFinal,
      },
    );

    expect(report.state).toBe('failed');
    expect(executions).toBe(1);
    expect(diagnoses).toBe(0);
  });

  it('stops after one failed stronger child and never verifies the plan', async () => {
    const { approved, store, artifactsRoot } = await harness(['first-step', 'second-step']);
    const seen: StepExecutionOptions[] = [];
    let diagnoses = 0;
    let finalRan = false;

    const report = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: (options) => {
          seen.push(options);
          return Promise.resolve({
            status: 'failed',
            attempt: options.attempt,
            category: 'agent_failed',
            message: `${options.profile.id} failed`,
          });
        },
        diagnose: () => {
          diagnoses += 1;
          return diagnosed();
        },
        verifyFinal: () => {
          finalRan = true;
          return passingFinal();
        },
      },
    );

    expect(seen).toHaveLength(2);
    expect(diagnoses).toBe(1);
    expect(finalRan).toBe(false);
    expect(report.state).toBe('failed');
    expect(report.steps[1]?.status).toBe('pending');
    expect(report.steps[0]?.attempts).toHaveLength(2);
  });

  it('does not diagnose a commit-plus-cleanup failure', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];
    const accept = committingExecutor(repo, seen);
    let diagnoses = 0;

    const report = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: async (options) => ({
          ...(await accept(options)),
          status: 'failed',
          category: 'internal_error',
          message: 'cleanup failed',
          cleanupErrors: ['volume survived'],
        }),
        diagnose: () => {
          diagnoses += 1;
          return diagnosed();
        },
        verifyFinal: passingFinal,
      },
    );

    expect(diagnoses).toBe(0);
    expect(report.state).toBe('failed');
    expect(report.steps[0]?.status).toBe('completed');
  });
});

describe('plan artifacts and reports', () => {
  async function tree(root: string): Promise<string[]> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).replace(`${root}/`, ''))
      .sort();
  }

  it('allocates a per-plan tree and writes a new report for every invocation', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];

    const first = await runPlan(
      { approved, store, artifactsRoot },
      { execute: committingExecutor(repo, seen), verifyFinal: passingFinal },
    );

    const files = await tree(artifactsRoot);
    expect(files).toContain('demo-plan/plan.yml');
    expect(files).toContain('demo-plan/reports/invocation-1.json');
    expect(
      seen[0]?.artifactDir.replace(`${artifactsRoot}/`, ''),
    ).toBe('demo-plan/steps/first-step/' + (seen[0]?.attempt ?? '') + '/run-1');

    const stored = JSON.parse(
      await readFile(join(artifactsRoot, 'demo-plan/reports/invocation-1.json'), 'utf8'),
    ) as PlanReport;
    expect(stored.state).toBe('completed');
    expect(stored.head).toBe(first.head);
    expect(stored.steps[0]?.commit).toBe(first.steps[0]?.commit);
    expect(stored.finalVerification?.status).toBe('pass');
  });

  it('returns the stored report for a completed plan without running anything again', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];

    const first = await runPlan(
      { approved, store, artifactsRoot },
      { execute: committingExecutor(repo, seen), verifyFinal: passingFinal },
    );

    let ranAgain = false;
    const second = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: () => {
          ranAgain = true;
          return Promise.reject(new Error('should not run'));
        },
        verifyFinal: () => {
          ranAgain = true;
          return Promise.reject(new Error('should not run'));
        },
      },
    );

    expect(ranAgain).toBe(false);
    expect(second).toEqual(first);
    expect(await tree(artifactsRoot)).toContain('demo-plan/reports/invocation-1.json');
    expect(await tree(artifactsRoot)).not.toContain('demo-plan/reports/invocation-2.json');
  });
});

describe('snapshot retention', () => {
  it('keeps an attempt snapshots while it runs and prunes them when it terminates', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];
    const commit = committingExecutor(repo, seen);
    let duringRun: string[] = [];

    const report = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: async (options) => {
          await options.snapshots.put(Buffer.from('pre-agent tree'), '.tar');
          await options.snapshots.put(Buffer.from('implementation tree'), '.tar');
          duringRun = await readdir(join(artifactsRoot, 'demo-plan/snapshots'));
          return commit(options);
        },
        verifyFinal: passingFinal,
      },
    );

    expect(duringRun).toHaveLength(2);
    expect(report.state).toBe('completed');

    // The completed attempt needs no acceptance recovery, so nothing of it is retained.
    await expect(readdir(join(artifactsRoot, 'demo-plan/snapshots'))).resolves.toEqual([]);

    // The hashes stay in the attempt's evidence even though the blobs are gone. Looked up by
    // manifest, not by "active plan": this plan is completed, so it owns the repository no
    // longer.
    const plan = store.planForManifest(repo.dir, approved.manifestHash);
    expect(store.attempts(store.steps(plan?.row ?? 0)[0]?.row ?? 0)[0]?.candidateSnapshot).toBe(
      `sha256:${'e'.repeat(64)}`,
    );
  });

  /**
   * A row left in `accepting` is what a killed process leaves behind — the executor never
   * returned, so nothing wrote a terminal state. A failure the executor *returns* is a
   * recorded failure and is pruned like any other terminated attempt, which is why this
   * exercises the retention rule directly rather than through a fake executor.
   */
  it('retains only the acceptance candidate of an attempt left in accepting', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const snapshots = new ArtifactStore(join(artifactsRoot, 'demo-plan', 'snapshots'));

    const plan = store.registerPlan({
      planId: approved.plan.id,
      manifestHash: approved.manifestHash,
      planHash: approved.planHash,
      repoPath: repo.dir,
      branch: 'ai-harness/demo-plan',
      baseCommit: approved.baseCommit,
      stepIds: ['first-step'],
    });
    const step = store.steps(plan.row)[0];
    if (step === undefined) throw new Error('expected a seeded step');

    const attempt = store.startAttempt({
      stepRow: step.row,
      attemptId: 'attempt-1',
      profileId: 'codex-fast',
      parentCommit: approved.baseCommit,
      artifactPath: join(artifactsRoot, 'unused'),
    });

    const candidate = await snapshots.put(Buffer.from('the verified candidate'), '.tar');
    await snapshots.put(Buffer.from('a scratch snapshot'), '.tar');

    // While the attempt is running the verifier still reads every blob it has taken.
    await pruneSnapshots(store, plan.row, snapshots);
    await expect(readdir(join(artifactsRoot, 'demo-plan', 'snapshots'))).resolves.toHaveLength(2);

    store.setAttemptCandidate(attempt.row, candidate.hash, `sha256:${'k'.repeat(64)}`);
    store.setAttemptState(attempt.row, 'accepting');

    await pruneSnapshots(store, plan.row, snapshots);

    const kept = await readdir(join(artifactsRoot, 'demo-plan', 'snapshots'));
    expect(kept).toHaveLength(1);
    expect(await snapshots.read(candidate.hash, '.tar')).toEqual(
      Buffer.from('the verified candidate'),
    );
  });
});

describe('final verification failure boundary', () => {
  it('fails the plan and reports the error when the verifier throws', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];

    const report = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: committingExecutor(repo, seen),
        verifyFinal: () => Promise.reject(new Error('final head does not resolve')),
      },
    );

    expect(report.state).toBe('failed');
    expect(report.head).toBe(await git(repo.dir, ['rev-parse', 'ai-harness/demo-plan']));
    expect(report.failure?.message).toContain('final head does not resolve');
    expect(report.steps[0]?.status).toBe('completed');

    // The report exists on disk: a thrown verifier is not a silent exit.
    const stored = JSON.parse(
      await readFile(join(artifactsRoot, 'demo-plan/reports/invocation-1.json'), 'utf8'),
    ) as PlanReport;
    expect(stored.state).toBe('failed');
  });

  it('fails the plan when the verifier passes but could not release its resources', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];

    const report = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: committingExecutor(repo, seen),
        verifyFinal: async (options) => ({
          ...(await passingFinal()),
          head: options.head,
          cleanupErrors: ['volume ai-harness-ws-final still present'],
        }),
      },
    );

    expect(report.state).toBe('failed');
    expect(report.finalVerification?.status).toBe('pass');
    expect(report.cleanupErrors).toEqual(['volume ai-harness-ws-final still present']);
    expect(report.steps[0]?.status).toBe('completed');
  });

  it('still completes on an ordinary pass', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];

    const report = await runPlan(
      { approved, store, artifactsRoot },
      { execute: committingExecutor(repo, seen), verifyFinal: passingFinal },
    );

    expect(report.state).toBe('completed');
    expect(report.cleanupErrors).toBeUndefined();
  });
});

describe('completed report durability', () => {
  /**
   * The failure surfaces as a rejection rather than a report, and has to: the coordinator
   * could not write a report, so it has no way to hand back one that also exists on disk.
   * `execute` in production.ts turns this into a non-zero JSON error for the operator.
   */
  it('does not mark the plan completed when its report cannot be written', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];

    await expect(
      runPlan(
        { approved, store, artifactsRoot },
        {
          execute: committingExecutor(repo, seen),
          verifyFinal: passingFinal,
          writeReport: () => Promise.reject(new Error('artifact volume is full')),
        },
      ),
    ).rejects.toThrow('artifact volume is full');

    expect(store.planForManifest(repo.dir, approved.manifestHash)?.state).not.toBe('completed');
  });

  it('reruns final verification after a failed report write rather than returning a stale one', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];

    await expect(
      runPlan(
        { approved, store, artifactsRoot },
        {
          execute: committingExecutor(repo, seen),
          verifyFinal: passingFinal,
          writeReport: () => Promise.reject(new Error('artifact volume is full')),
        },
      ),
    ).rejects.toThrow();

    let finalRuns = 0;
    const second = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: committingExecutor(repo, seen),
        verifyFinal: async (options) => {
          finalRuns += 1;
          return { ...(await passingFinal()), head: options.head };
        },
      },
    );

    // The accepted step is not rerun, but the plan is not completed on the strength of a
    // report nobody could read.
    expect(seen).toHaveLength(1);
    expect(finalRuns).toBe(1);
    expect(second.state).toBe('completed');
    expect(store.planForManifest(repo.dir, approved.manifestHash)?.state).toBe('completed');
  });

  it('prunes final snapshots before marking the plan completed', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];
    const remove = ArtifactStore.prototype.remove;
    let stateDuringPrune: string | undefined;

    vi.spyOn(ArtifactStore.prototype, 'remove').mockImplementation(async function (
      this: ArtifactStore,
      artifact,
    ) {
      stateDuringPrune = store.planForManifest(repo.dir, approved.manifestHash)?.state;
      await remove.call(this, artifact);
    });

    const report = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: committingExecutor(repo, seen),
        verifyFinal: async (options) => {
          await options.snapshots.put(Buffer.from('final export'), '.tar');
          return { ...(await passingFinal()), head: options.head };
        },
      },
    );

    expect(report.state).toBe('completed');
    expect(stateDuringPrune).toBe('running');
    await expect(readdir(join(artifactsRoot, 'demo-plan/snapshots'))).resolves.toEqual([]);
  });

  it('completes once the report is durable, and later runs return it unchanged', async () => {
    const { repo, approved, store, artifactsRoot } = await harness(['first-step']);
    const seen: StepExecutionOptions[] = [];

    const first = await runPlan(
      { approved, store, artifactsRoot },
      { execute: committingExecutor(repo, seen), verifyFinal: passingFinal },
    );
    expect(first.state).toBe('completed');

    const stored = JSON.parse(
      await readFile(join(artifactsRoot, 'demo-plan/reports/invocation-1.json'), 'utf8'),
    ) as PlanReport;
    expect(stored.state).toBe('completed');

    const second = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: () => Promise.reject(new Error('should not run')),
        verifyFinal: () => Promise.reject(new Error('should not run')),
      },
    );

    expect(second).toEqual(first);
    expect(seen).toHaveLength(1);
  });
});
