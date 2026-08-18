import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeImages } from '../../src/docker/images.js';
import {
  buildManifest,
  loadManifest,
  validateManifest,
  writeManifest,
  type ApprovedInputs,
} from '../../src/plan/execution-manifest.js';
import {
  runPlan,
  type PlanProgress,
} from '../../src/run/coordinator.js';
import type { DiagnosisResult } from '../../src/run/diagnosis.js';
import type { RunReport, StepExecutionOptions } from '../../src/run/orchestrator.js';
import { PROFILES } from '../../src/routing/profiles.js';
import { StateStore } from '../../src/state/store.js';
import type { FinalVerificationResult } from '../../src/verify/final.js';
import { commitAll, createM2Repo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';

const IMAGES: RuntimeImages = {
  codex: { role: 'codex', id: `sha256:${'a'.repeat(64)}` },
  claude: { role: 'claude', id: `sha256:${'e'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'b'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'c'.repeat(64)}` },
  reviewer: { role: 'reviewer', id: `sha256:${'9'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'d'.repeat(64)}` },
};

const dirs: string[] = [];
const repos: string[] = [];
const stores: StateStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(repos.splice(0).map((dir) => removeRepo(dir)));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'enactment-progress-'));
  dirs.push(dir);
  return dir;
}

function planDocument(stepIds: string[], complexities: Record<string, string> = {}): string {
  return [
    'version: 1',
    'id: demo-plan',
    'steps:',
    ...stepIds.flatMap((id) => [
      '  - type: task',
      `    complexity: ${complexities[id] ?? 'low'}`,
      '    risk: standard',
      `    id: ${id}`,
      `    observable_behavior: Do ${id}.`,
      '    implementation_paths:',
      `      - src/${id}.js`,
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
}

async function harness(
  stepIds = ['first-step', 'second-step'],
  complexities: Record<string, string> = {},
): Promise<Harness> {
  const repo = await createM2Repo();
  repos.push(repo.dir);

  const dir = await scratch();
  const planFile = join(dir, 'plan.yml');
  await writeFile(planFile, planDocument(stepIds, complexities));

  const manifestPath = join(dir, 'execution-manifest.yml');
  await writeManifest(
    manifestPath,
    (
      await buildManifest({
        planFile,
        manifestPath,
        repoPath: repo.dir,
        resolveImages: () => Promise.resolve(IMAGES),
      })
    ).manifest,
  );

  const approved = await validateManifest(await loadManifest(manifestPath), {
    repoPath: repo.dir,
    resolveImages: () => Promise.resolve(IMAGES),
  });
  const store = StateStore.open(join(await scratch(), 'state.db'));
  stores.push(store);

  return { repo, approved, store, artifactsRoot: await scratch() };
}

const passingFinal = (): Promise<FinalVerificationResult> =>
  Promise.resolve({
    status: 'pass',
    head: 'unused',
    commands: [],
    dependencyCacheKey: `sha256:${'f'.repeat(64)}`,
    exportHash: `sha256:${'0'.repeat(64)}`,
    runtime: {
      enactment_version: '0.1.0',
      codex_image_id: IMAGES.codex.id,
      claude_image_id: IMAGES.claude.id,
      verifier_image_id: IMAGES.verifier.id,
      reviewer_image_id: IMAGES.reviewer.id,
      setup_image_id: IMAGES.setup.id,
      proxy_image_id: IMAGES.proxy.id,
    },
  });

async function accept(options: StepExecutionOptions): Promise<RunReport> {
  await writeFile(join(options.repoPath, `${options.step.id}.txt`), `${options.step.id}\n`);
  const commit = await commitAll(options.repoPath, `${options.step.id}: fake acceptance`);
  await git(options.repoPath, [
    'update-ref',
    `refs/heads/${options.branch}`,
    commit,
    options.branchExists ? options.parentCommit : '',
  ]);
  await git(options.repoPath, ['reset', '--hard', options.parentCommit]);
  await options.onEvent?.({ kind: 'candidate', snapshot: `sha256:${'7'.repeat(64)}` });
  await options.onEvent?.({ kind: 'accepting' });
  return { status: 'succeeded', attempt: options.attempt, commit, branch: options.branch };
}

function capture(): { events: PlanProgress[]; onProgress: (event: PlanProgress) => void } {
  const events: PlanProgress[] = [];
  return { events, onProgress: (event) => events.push(event) };
}

describe('plan progress', () => {
  it('emits plan metadata, ordered attempts, executor phases, outcomes, and final verification', async () => {
    const { approved, store, artifactsRoot } = await harness(
      ['first-step', 'second-step'],
      { 'second-step': 'medium' },
    );
    const progress = capture();

    const report = await runPlan(
      { approved, store, artifactsRoot, onProgress: progress.onProgress },
      {
        execute: async (options) => {
          if (options.step.id === 'first-step') {
            await options.onEvent?.({ kind: 'phase', phase: 'tests' });
            await options.onEvent?.({ kind: 'phase', phase: 'implementation' });
          } else {
            await options.onEvent?.({ kind: 'phase', phase: 'runtime' });
            await options.onEvent?.({ kind: 'phase', phase: 'review' });
          }
          return accept(options);
        },
        verifyFinal: passingFinal,
      },
    );

    expect(report.state).toBe('completed');
    expect(progress.events).toEqual([
      {
        kind: 'plan',
        planId: 'demo-plan',
        planFile: approved.planFile,
        steps: 2,
        repoPath: approved.repoPath,
        baseBranch: approved.baseBranch,
        baseCommit: approved.baseCommit,
        branch: 'enactment/demo-plan',
        artifactsRoot: join(artifactsRoot, 'demo-plan'),
      },
      {
        kind: 'step',
        index: 1,
        total: 2,
        stepId: 'first-step',
        stepType: 'task',
        attempt: 'normal',
        provider: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'medium',
      },
      { kind: 'phase', name: 'tests' },
      { kind: 'phase', name: 'implementation' },
      { kind: 'stepDone', status: 'committed', commit: report.steps[0]?.commit },
      {
        kind: 'step',
        index: 2,
        total: 2,
        stepId: 'second-step',
        stepType: 'task',
        attempt: 'normal',
        provider: 'claude',
        model: 'claude-sonnet-5',
        effort: 'medium',
      },
      { kind: 'phase', name: 'runtime' },
      { kind: 'phase', name: 'review' },
      { kind: 'stepDone', status: 'committed', commit: report.steps[1]?.commit },
      { kind: 'phase', name: 'final' },
    ]);

    const plan = store.planForManifest(approved.repoPath, approved.manifestHash);
    const attempts = plan === undefined ? [] : store.attempts(store.steps(plan.row)[1]?.row ?? 0);
    expect(attempts[0]?.phase).toBe('review');
  });

  it('reports a failed step with its category, message, and evidence directory', async () => {
    const { approved, store, artifactsRoot } = await harness(['first-step']);
    const progress = capture();
    let evidence: string | undefined;

    const report = await runPlan(
      { approved, store, artifactsRoot, onProgress: progress.onProgress },
      {
        execute: async (options) => {
          evidence = options.artifactDir;
          await options.onEvent?.({ kind: 'phase', phase: 'red' });
          return {
            status: 'failed',
            attempt: options.attempt,
            failedPhase: 'red',
            category: 'red_invalid',
            message: 'expected tests were not all discovered and failing',
          };
        },
        verifyFinal: passingFinal,
      },
    );

    expect(report.state).toBe('failed');
    expect(progress.events.at(-1)).toEqual({
      kind: 'stepDone',
      status: 'failed',
      category: 'red_invalid',
      message: 'expected tests were not all discovered and failing',
      evidence,
    });
  });

  it('reports an accepted commit before a cleanup failure stops the plan', async () => {
    const { approved, store, artifactsRoot } = await harness(['first-step']);
    const progress = capture();

    const report = await runPlan(
      { approved, store, artifactsRoot, onProgress: progress.onProgress },
      {
        execute: async (options) => ({
          ...(await accept(options)),
          status: 'failed',
          category: 'internal_error',
          message: 'cleanup failed',
          cleanupErrors: ['volume survived'],
        }),
        verifyFinal: passingFinal,
      },
    );

    expect(report.state).toBe('failed');
    expect(report.steps[0]?.status).toBe('completed');
    expect(progress.events.at(-1)).toEqual({
      kind: 'stepDone',
      status: 'committed',
      commit: report.steps[0]?.commit,
    });
  });

  it('reports diagnosis and the stronger retry profile', async () => {
    const { approved, store, artifactsRoot } = await harness(['first-step']);
    const progress = capture();
    let executions = 0;
    const diagnosis: DiagnosisResult = {
      status: 'completed',
      text: 'Check the allowed source scope.',
    };

    const report = await runPlan(
      { approved, store, artifactsRoot, onProgress: progress.onProgress },
      {
        execute: async (options) => {
          executions += 1;
          if (executions === 1) {
            return {
              status: 'failed',
              attempt: options.attempt,
              category: 'agent_failed',
              message: 'normal attempt failed',
            };
          }
          return accept(options);
        },
        diagnose: () => Promise.resolve(diagnosis),
        verifyFinal: passingFinal,
      },
    );

    expect(report.state).toBe('completed');
    const diagnosisIndex = progress.events.findIndex(
      (event) => event.kind === 'phase' && event.name === 'diagnosis',
    );
    expect(diagnosisIndex).toBeGreaterThan(0);
    expect(progress.events[diagnosisIndex + 1]).toEqual({
      kind: 'step',
      index: 1,
      total: 1,
      stepId: 'first-step',
      stepType: 'task',
      attempt: 'stronger',
      provider: PROFILES['claude-deep'].provider,
      model: PROFILES['claude-deep'].model,
      effort: PROFILES['claude-deep'].effort,
    });
  });

  it('emits only plan metadata for a cancelled plan', async () => {
    const { approved, store, artifactsRoot } = await harness(['first-step']);
    const registered = store.registerPlan({
      planId: approved.plan.id,
      manifestHash: approved.manifestHash,
      planHash: approved.planHash,
      repoPath: approved.repoPath,
      branch: `enactment/${approved.plan.id}`,
      baseCommit: approved.baseCommit,
      stepIds: approved.plan.steps.map((step) => step.id),
    });
    store.setPlanState(registered.row, 'cancelled');
    const progress = capture();

    const report = await runPlan(
      { approved, store, artifactsRoot, onProgress: progress.onProgress },
      {
        execute: () => Promise.reject(new Error('must not execute')),
        verifyFinal: () => Promise.reject(new Error('must not verify')),
      },
    );

    expect(report.state).toBe('cancelled');
    expect(progress.events).toEqual([
      expect.objectContaining({ kind: 'plan', planId: 'demo-plan', steps: 1 }),
    ]);
  });

  it('keeps reports and state writes unchanged when progress is not supplied', async () => {
    const { approved, store, artifactsRoot } = await harness(['first-step']);

    const report = await runPlan(
      { approved, store, artifactsRoot },
      {
        execute: async (options) => {
          await options.onEvent?.({ kind: 'phase', phase: 'tests' });
          return accept(options);
        },
        verifyFinal: passingFinal,
      },
    );

    const plan = store.planForManifest(approved.repoPath, approved.manifestHash);
    const step = plan === undefined ? undefined : store.steps(plan.row)[0];
    const attempt = step === undefined ? undefined : store.attempts(step.row)[0];

    expect(report.state).toBe('completed');
    expect(report.steps[0]?.status).toBe('completed');
    expect(attempt?.phase).toBe('tests');
    expect(attempt?.state).toBe('completed');
  });
});
