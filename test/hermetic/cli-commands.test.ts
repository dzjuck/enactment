import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeImages } from '../../src/docker/images.js';
import {
  loadManifest,
  validateManifest,
  type ApprovedInputs,
} from '../../src/plan/execution-manifest.js';
import type { CoordinatorOptions, PlanReport } from '../../src/run/coordinator.js';
import { CliUsageError, parseCommand } from '../../src/run/options.js';
import { execute, type CommandResult } from '../../src/run/production.js';
import { StateStore } from '../../src/state/store.js';
import { commitAll, createM2Repo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';

const IMAGES: RuntimeImages = {
  codex: { role: 'codex', id: `sha256:${'a'.repeat(64)}` },
  claude: { role: 'claude', id: `sha256:${'e'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'b'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'c'.repeat(64)}` },
  reviewer: { role: 'reviewer', id: `sha256:${'9'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'d'.repeat(64)}` },
};

const PLAN = [
  'version: 1',
  'id: demo-plan',
  'steps:',
  '  - type: task',
  '    complexity: low',
  '    risk: standard',
  '    id: only-step',
  '    observable_behavior: Do the thing.',
  '    implementation_paths:',
  '      - only-step.txt',
  '    verification:',
  '      commands:',
  '        - ["node", "--version"]',
  'final_verification:',
  '  commands:',
  '    - ["node", "--version"]',
  '',
].join('\n');

/** The same plan with a second step, for warning about more than one accepted ID. */
const TWO_STEP_PLAN = PLAN.replace(
  'final_verification:',
  [
    '  - type: task',
    '    complexity: low',
    '    risk: standard',
    '    id: second-step',
    '    observable_behavior: Do the other thing.',
    '    implementation_paths:',
    '      - second-step.txt',
    '    verification:',
    '      commands:',
    '        - ["node", "--version"]',
    'final_verification:',
  ].join('\n'),
);

const dirs: string[] = [];
const repos: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(repos.splice(0).map((dir) => removeRepo(dir)));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-cli-'));
  dirs.push(dir);
  return dir;
}

interface Workspace {
  repo: TargetRepo;
  planFile: string;
  manifestPath: string;
  artifactDir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}

async function workspace(plan = PLAN): Promise<Workspace> {
  const repo = await createM2Repo();
  repos.push(repo.dir);

  const dir = await scratch();
  const planFile = join(dir, 'plan.yml');
  await writeFile(planFile, plan);

  const stateDir = join(dir, 'state');

  return {
    repo,
    planFile,
    manifestPath: join(dir, 'execution-manifest.yml'),
    artifactDir: join(dir, 'artifacts'),
    stateDir,
    env: { HARNESS_STATE_DIR: stateDir },
  };
}

const succeeded = (options: CoordinatorOptions): Promise<PlanReport> =>
  Promise.resolve({
    plan: options.approved.plan.id,
    state: 'completed',
    branch: `ai-harness/${options.approved.plan.id}`,
    baseCommit: options.approved.baseCommit,
    head: 'c'.repeat(40),
    steps: [{ id: 'only-step', status: 'completed', attempts: [], commit: 'c'.repeat(40) }],
  });

function prepareWith(
  space: Workspace,
  extra: string[] = [],
  output = space.manifestPath,
): Promise<CommandResult> {
  return execute(
    parseCommand(
      ['prepare', space.planFile, '--repo', space.repo.dir, '--output', output, ...extra],
      space.env,
    ),
    { resolveImages: () => Promise.resolve(IMAGES) },
  );
}

async function prepare(space: Workspace): Promise<void> {
  expect((await prepareWith(space)).exitCode).toBe(0);
}

/** A commit reachable from no branch, so `--base` cannot be resolving the checked-out head. */
async function offBranchCommit(repo: TargetRepo): Promise<string> {
  const tree = await git(repo.dir, ['rev-parse', 'HEAD^{tree}']);
  return git(repo.dir, ['commit-tree', tree, '-p', repo.commit, '-m', 'off-branch']);
}

/** What an accepted step leaves behind: a commit on the checked-out branch, with trailers. */
function acceptanceMessage(stepId: string): string {
  return [
    `${stepId}: accepted work`,
    '',
    'AI-Harness-Plan: previous-revision',
    `AI-Harness-Step: ${stepId}`,
    `AI-Harness-Attempt: ${'0'.repeat(16)}`,
  ].join('\n');
}

async function acceptStep(repo: TargetRepo, stepId: string): Promise<string> {
  await writeFile(join(repo.dir, `${stepId}.txt`), `${stepId}\n`);
  return commitAll(repo.dir, acceptanceMessage(stepId));
}

interface StepWarning {
  step: string;
  commit: string;
  message: string;
}

function warningsOf(result: CommandResult): StepWarning[] | undefined {
  return (result.report as { warnings?: StepWarning[] }).warnings;
}

describe('command parsing', () => {
  it('accepts the three documented shapes', () => {
    expect(
      parseCommand(['prepare', 'plan.yml', '--repo', '/repo', '--output', 'm.yml'], {}),
    ).toMatchObject({ kind: 'prepare', planFile: 'plan.yml', repoPath: '/repo', output: 'm.yml' });

    expect(
      parseCommand(['run', 'm.yml', '--repo', '/repo', '--artifacts', '/out'], {}),
    ).toMatchObject({ kind: 'run', manifestPath: 'm.yml', repoPath: '/repo', artifactDir: '/out' });

    expect(parseCommand(['cancel', 'm.yml', '--repo', '/repo'], {})).toMatchObject({
      kind: 'cancel',
      manifestPath: 'm.yml',
      repoPath: '/repo',
    });
  });

  it('accepts --base on prepare only', () => {
    expect(
      parseCommand(
        ['prepare', 'plan.yml', '--repo', '/repo', '--output', 'm.yml', '--base', 'ai-harness/r1'],
        {},
      ),
    ).toMatchObject({ kind: 'prepare', base: 'ai-harness/r1' });

    // Omitted, not defaulted: today's behavior is what an absent base means.
    expect(
      parseCommand(['prepare', 'plan.yml', '--repo', '/repo', '--output', 'm.yml'], {}),
    ).not.toHaveProperty('base');
  });

  it.each([
    ['the removed task CLI', ['run', 'task.yml']],
    ['an unknown command', ['execute', 'm.yml', '--repo', '/repo']],
    ['a missing repository', ['run', 'm.yml']],
    ['a missing plan file', ['prepare', '--repo', '/repo', '--output', 'm.yml']],
    ['a missing output path', ['prepare', 'plan.yml', '--repo', '/repo']],
    ['a surplus positional', ['cancel', 'm.yml', 'extra', '--repo', '/repo']],
    ['an output flag on cancel', ['cancel', 'm.yml', '--repo', '/repo', '--output', '/out']],
    ['an image override', ['run', 'm.yml', '--repo', '/repo', '--agent-image', 'x']],
    ['a network override', ['run', 'm.yml', '--repo', '/repo', '--network', 'host']],
    ['an allowlist override', ['run', 'm.yml', '--repo', '/repo', '--allow-host', 'evil.test']],
    ['a base flag on run', ['run', 'm.yml', '--repo', '/repo', '--base', 'ai-harness/r1']],
    ['a base flag on cancel', ['cancel', 'm.yml', '--repo', '/repo', '--base', 'ai-harness/r1']],
    ['a base flag on docs', ['docs', 'plan.yml', '--base', 'ai-harness/r1']],
  ])('rejects %s', (_label, argv) => {
    expect(() => parseCommand(argv, {})).toThrow(CliUsageError);
  });

  it('reads only the harness state environment variables', () => {
    const command = parseCommand(['run', 'm.yml', '--repo', '/repo'], {
      HARNESS_SOURCE_CODEX_HOME: '/codex',
      HARNESS_STORE_DIR: '/store',
      HARNESS_DEPS_DIR: '/deps',
      HARNESS_AGENT_ENV: JSON.stringify({ CODEX_HOME: '/evil' }),
    });

    expect(command).toMatchObject({
      sourceCodexHome: '/codex',
      storeDirectory: '/store',
      dependencyCacheDirectory: '/deps',
    });
    expect(JSON.stringify(command)).not.toContain('evil');
  });
});

describe('prepare', () => {
  it('writes the candidate manifest and creates no plan state', async () => {
    const space = await workspace();
    await prepare(space);

    const manifest = await loadManifest(space.manifestPath);
    expect(manifest.manifest.repository.base_commit).toBe(space.repo.commit);
    expect(manifest.manifest.runtime.codex_image_id).toBe(IMAGES.codex.id);

    await expect(access(join(space.stateDir, 'state.db'))).rejects.toThrow();
  });

  it('leaves Git untouched', async () => {
    const space = await workspace();
    const refsBefore = await git(space.repo.dir, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
    ]);

    await prepare(space);

    expect(await git(space.repo.dir, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(
      refsBefore,
    );
  });

  it('hands run exactly the base and images it recorded', async () => {
    const space = await workspace();
    await prepare(space);

    let approved: ApprovedInputs | undefined;
    const result = await execute(
      parseCommand(
        ['run', space.manifestPath, '--repo', space.repo.dir, '--artifacts', space.artifactDir],
        space.env,
      ),
      {
        sweep: () => Promise.resolve(),
        resolveImages: () => Promise.resolve(IMAGES),
        coordinate: (options) => {
          approved = options.approved;
          return succeeded(options);
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(approved?.baseCommit).toBe(space.repo.commit);
    expect(approved?.images).toEqual(IMAGES);
    expect(approved?.plan.id).toBe('demo-plan');
  });
});

describe('prepare --base', () => {
  it('records the tip of a named ref, re-read every time it is resolved', async () => {
    const space = await workspace();
    await git(space.repo.dir, ['branch', 'ai-harness/r1', space.repo.commit]);

    expect((await prepareWith(space, ['--base', 'ai-harness/r1'])).exitCode).toBe(0);
    expect((await loadManifest(space.manifestPath)).manifest.repository).toEqual({
      base_branch: 'ai-harness/r1',
      base_commit: space.repo.commit,
    });

    // The ref is resolved at prepare time, not remembered from a previous manifest.
    await writeFile(join(space.repo.dir, 'accepted.txt'), 'x\n');
    const moved = await commitAll(space.repo.dir, 'a later accepted step');
    await git(space.repo.dir, ['branch', '-f', 'ai-harness/r1', moved]);

    const second = join(dirname(space.manifestPath), 'execution-manifest-r2.yml');
    expect((await prepareWith(space, ['--base', 'ai-harness/r1'], second)).exitCode).toBe(0);
    expect((await loadManifest(second)).manifest.repository).toEqual({
      base_branch: 'ai-harness/r1',
      base_commit: moved,
    });
  });

  it('records a full SHA that no branch contains, and the given string as the ref', async () => {
    const space = await workspace();
    const orphan = await offBranchCommit(space.repo);

    expect((await prepareWith(space, ['--base', orphan])).exitCode).toBe(0);

    expect((await loadManifest(space.manifestPath)).manifest.repository).toEqual({
      base_branch: orphan,
      base_commit: orphan,
    });
    expect(await git(space.repo.dir, ['branch', '--contains', orphan])).toBe('');
  });

  it.each([
    ['a nonexistent ref', () => Promise.resolve('ai-harness/never-created')],
    ['an object that is not a commit', (repo: TargetRepo) => git(repo.dir, ['rev-parse', 'HEAD^{tree}'])],
  ])('fails as base_unresolvable for %s, writing nothing', async (_label, resolve) => {
    const space = await workspace();
    const ref = await resolve(space.repo);

    const result = await prepareWith(space, ['--base', ref]);

    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({ error: 'base_unresolvable' });
    expect((result.report as { message: string }).message).toContain(ref);
    await expect(access(space.manifestPath)).rejects.toThrow();
  });

  it('still records the repository head and its branch name when omitted', async () => {
    const space = await workspace();
    await prepare(space);

    expect((await loadManifest(space.manifestPath)).manifest.repository).toEqual({
      base_branch: 'main',
      base_commit: space.repo.commit,
    });
  });

  it('changes the manifest hash, so the base is part of what the user approves', async () => {
    const space = await workspace();
    const orphan = await offBranchCommit(space.repo);

    await prepare(space);
    const head = (await loadManifest(space.manifestPath)).manifestHash;

    const other = join(dirname(space.manifestPath), 'execution-manifest-r2.yml');
    expect((await prepareWith(space, ['--base', orphan], other)).exitCode).toBe(0);

    expect((await loadManifest(other)).manifestHash).not.toBe(head);
  });
});

describe('prepare warnings about already-accepted steps', () => {
  it('names the step and the commit that carries it, and still writes an approvable manifest', async () => {
    const space = await workspace();
    const carrier = await acceptStep(space.repo, 'only-step');

    const result = await prepareWith(space, ['--base', 'main']);

    expect(result.exitCode).toBe(0);
    expect(warningsOf(result)).toHaveLength(1);
    expect(warningsOf(result)?.[0]).toMatchObject({ step: 'only-step', commit: carrier });
    // Both fixes, because the harness cannot tell which one applies.
    expect(warningsOf(result)?.[0]?.message).toMatch(/remove/i);
    expect(warningsOf(result)?.[0]?.message).toMatch(/rename/i);

    // A warning is not a refusal: the manifest is on disk and approvable.
    const approved = await validateManifest(await loadManifest(space.manifestPath), {
      repoPath: space.repo.dir,
      resolveImages: () => Promise.resolve(IMAGES),
    });
    expect(approved.baseCommit).toBe(carrier);
  });

  it('warns about every colliding step, not only the first', async () => {
    const space = await workspace(TWO_STEP_PLAN);
    const first = await acceptStep(space.repo, 'only-step');
    const second = await acceptStep(space.repo, 'second-step');

    const result = await prepareWith(space, ['--base', 'main']);

    expect(result.exitCode).toBe(0);
    expect(warningsOf(result)).toEqual([
      expect.objectContaining({ step: 'only-step', commit: first }),
      expect.objectContaining({ step: 'second-step', commit: second }),
    ]);
  });

  it('carries no warnings key at all when nothing collides', async () => {
    const space = await workspace();
    await writeFile(join(space.repo.dir, 'unrelated.txt'), 'x\n');
    await commitAll(space.repo.dir, 'an ordinary commit with no trailers');

    const result = await prepareWith(space, ['--base', 'main']);

    expect(result.exitCode).toBe(0);
    expect(result.report).not.toHaveProperty('warnings');
  });

  it('ignores a trailer the base cannot reach, and finds the same one when it can', async () => {
    const space = await workspace();
    const tree = await git(space.repo.dir, ['rev-parse', 'HEAD^{tree}']);
    const sibling = await git(space.repo.dir, [
      'commit-tree',
      tree,
      '-p',
      space.repo.commit,
      '-m',
      acceptanceMessage('only-step'),
    ]);
    await git(space.repo.dir, ['branch', 'sibling', sibling]);

    const unreachable = await prepareWith(space, ['--base', 'main']);
    expect(unreachable.report).not.toHaveProperty('warnings');

    const reachable = await prepareWith(
      space,
      ['--base', 'sibling'],
      join(dirname(space.manifestPath), 'execution-manifest-sibling.yml'),
    );
    expect(warningsOf(reachable)).toEqual([
      expect.objectContaining({ step: 'only-step', commit: sibling }),
    ]);
  });

  it('scans the resolved base, not the repository head', async () => {
    const space = await workspace();
    const older = space.repo.commit;
    await acceptStep(space.repo, 'only-step');

    const fromOlder = await prepareWith(space, ['--base', older]);
    expect(fromOlder.report).not.toHaveProperty('warnings');

    const fromHead = await prepareWith(
      space,
      [],
      join(dirname(space.manifestPath), 'execution-manifest-head.yml'),
    );
    expect(warningsOf(fromHead)).toHaveLength(1);
  });
});

describe('run', () => {
  it('sweeps before it validates, and reports the plan outcome', async () => {
    const space = await workspace();
    await prepare(space);

    const order: string[] = [];
    const result = await execute(
      parseCommand(
        ['run', space.manifestPath, '--repo', space.repo.dir, '--artifacts', space.artifactDir],
        space.env,
      ),
      {
        sweep: () => {
          order.push('sweep');
          return Promise.resolve();
        },
        resolveImages: () => Promise.resolve(IMAGES),
        coordinate: (options) => {
          order.push('coordinate');
          return succeeded(options);
        },
      },
    );

    expect(order).toEqual(['sweep', 'coordinate']);
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({
      plan: 'demo-plan',
      state: 'completed',
      branch: 'ai-harness/demo-plan',
    });
  });

  it('exits non-zero and names the failed step when the plan fails', async () => {
    const space = await workspace();
    await prepare(space);

    const result = await execute(
      parseCommand(
        ['run', space.manifestPath, '--repo', space.repo.dir, '--artifacts', space.artifactDir],
        space.env,
      ),
      {
        sweep: () => Promise.resolve(),
        resolveImages: () => Promise.resolve(IMAGES),
        coordinate: (options) =>
          Promise.resolve({
            plan: options.approved.plan.id,
            state: 'failed' as const,
            branch: `ai-harness/${options.approved.plan.id}`,
            baseCommit: options.approved.baseCommit,
            steps: [{ id: 'only-step', status: 'pending' as const, attempts: [] }],
            failure: { step: 'only-step', category: 'agent_failed', message: 'injected' },
            cleanupErrors: ['volume v-stuck still present'],
          }),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({
      state: 'failed',
      failure: { step: 'only-step', category: 'agent_failed' },
      cleanupErrors: ['volume v-stuck still present'],
    });
  });

  it('fails on an approval mismatch before coordinating or opening plan state', async () => {
    const space = await workspace();
    await prepare(space);

    // The approved plan is no longer the plan on disk.
    await writeFile(space.planFile, `${PLAN}\n`);

    let started = false;
    const result = await execute(
      parseCommand(
        ['run', space.manifestPath, '--repo', space.repo.dir, '--artifacts', space.artifactDir],
        space.env,
      ),
      {
        sweep: () => Promise.resolve(),
        resolveImages: () => Promise.resolve(IMAGES),
        coordinate: () => {
          started = true;
          return Promise.reject(new Error('should not run'));
        },
      },
    );

    expect(started).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({ error: 'plan_changed' });
    await expect(access(join(space.stateDir, 'state.db'))).rejects.toThrow();
  });
});

describe('cancel', () => {
  /**
   * Drive a `run` that leaves a failed plan behind.
   *
   * The fake coordinator registers the plan itself, because registration is the coordinator's
   * job: `runPlan` does it, and a stand-in that skipped it would leave cancel with no state to
   * act on and the test asserting nothing.
   */
  async function registered(space: Workspace): Promise<void> {
    const result = await execute(
      parseCommand(
        ['run', space.manifestPath, '--repo', space.repo.dir, '--artifacts', space.artifactDir],
        space.env,
      ),
      {
        sweep: () => Promise.resolve(),
        resolveImages: () => Promise.resolve(IMAGES),
        coordinate: (options) => {
          const plan = options.store.registerPlan({
            planId: options.approved.plan.id,
            manifestHash: options.approved.manifestHash,
            planHash: options.approved.planHash,
            repoPath: options.approved.repoPath,
            branch: `ai-harness/${options.approved.plan.id}`,
            baseCommit: options.approved.baseCommit,
            stepIds: options.approved.plan.steps.map((step) => step.id),
          });
          options.store.setPlanState(plan.row, 'failed');

          return Promise.resolve({
            plan: options.approved.plan.id,
            state: 'failed' as const,
            branch: `ai-harness/${options.approved.plan.id}`,
            baseCommit: options.approved.baseCommit,
            steps: [{ id: 'only-step', status: 'pending' as const, attempts: [] }],
            failure: { step: 'only-step', message: 'injected' },
          });
        },
      },
    );

    expect(result.exitCode).toBe(1);
  }

  /** Record an accepted commit for the plan's first step, exactly as acceptance would. */
  function recordAcceptance(space: Workspace, commit: string): void {
    const store = StateStore.open(join(space.stateDir, 'state.db'));
    try {
      const plan = store.activePlanForRepo(space.repo.dir);
      if (plan === undefined) throw new Error('no plan owns the repository');
      const step = store.steps(plan.row)[0];
      if (step === undefined) throw new Error('the plan has no steps');

      const attempt = store.startAttempt({
        stepRow: step.row,
        attemptId: 'a'.repeat(16),
        profileId: 'codex-fast',
        parentCommit: plan.baseCommit,
        artifactPath: 'run-1',
      });
      store.completeAcceptance({
        planRow: plan.row,
        stepRow: step.row,
        attemptRow: attempt.row,
        commit,
      });
    } finally {
      store.close();
    }
  }

  function cancel(space: Workspace, repoPath = space.repo.dir) {
    return execute(parseCommand(['cancel', space.manifestPath, '--repo', repoPath], space.env), {});
  }

  it('names both commits an amendment could build on when a step was accepted', async () => {
    const space = await workspace();
    await prepare(space);
    await registered(space);

    await writeFile(join(space.repo.dir, 'accepted.txt'), 'x\n');
    const accepted = await commitAll(space.repo.dir, 'accepted step');
    await git(space.repo.dir, ['branch', 'ai-harness/demo-plan', accepted]);
    recordAcceptance(space, accepted);

    const result = await cancel(space);

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({
      plan: 'demo-plan',
      branch: 'ai-harness/demo-plan',
      head: accepted,
      base: space.repo.commit,
    });
  });

  it('reports the approved base and no head when the plan accepted nothing', async () => {
    const space = await workspace();
    await prepare(space);
    await registered(space);

    const result = await cancel(space);

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({ base: space.repo.commit });
    expect((result.report as { head?: string }).head).toBeUndefined();
  });

  it('reads the head from the ref, so a commit the database never recorded is still named', async () => {
    const space = await workspace();
    await prepare(space);
    await registered(space);

    // An acceptance interrupted between its commit and its database write: the branch carries
    // the commit, `plans.head_commit` does not.
    await writeFile(join(space.repo.dir, 'landed.txt'), 'x\n');
    const landed = await commitAll(space.repo.dir, 'landed but unrecorded');
    await git(space.repo.dir, ['branch', 'ai-harness/demo-plan', landed]);

    const result = await cancel(space);

    expect(result.report).toMatchObject({ head: landed, base: space.repo.commit });
  });

  it('releases the repository, preserves the branch and artifacts, and is idempotent', async () => {
    const space = await workspace();
    await prepare(space);
    await registered(space);

    // Evidence of the failed run: the plan branch, and a file under the plan's artifact tree.
    await git(space.repo.dir, ['branch', 'ai-harness/demo-plan', space.repo.commit]);
    const evidence = join(space.artifactDir, 'demo-plan', 'reports', 'invocation-1.json');
    await mkdir(join(evidence, '..'), { recursive: true });
    await writeFile(evidence, '{"state":"failed"}\n');

    const first = await cancel(space);
    expect(first.exitCode).toBe(0);
    expect(first.report).toMatchObject({ plan: 'demo-plan', state: 'cancelled' });

    // Idempotent: cancelling again is a success, not an error.
    const second = await cancel(space);
    expect(second.exitCode).toBe(0);
    expect(second.report).toMatchObject({ state: 'cancelled' });

    // Neither the branch nor the artifacts were touched.
    expect(await git(space.repo.dir, ['rev-parse', 'ai-harness/demo-plan'])).toBe(
      space.repo.commit,
    );
    expect(await readFile(evidence, 'utf8')).toBe('{"state":"failed"}\n');

    // The repository is free for a different manifest.
    const store = StateStore.open(join(space.stateDir, 'state.db'));
    try {
      expect(store.activePlanForRepo(space.repo.dir)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('refuses a repository the manifest does not own', async () => {
    const space = await workspace();
    await prepare(space);
    await registered(space);

    const other = await createM2Repo();
    repos.push(other.dir);

    const result = await cancel(space, other.dir);

    expect(result.exitCode).toBe(1);

    const store = StateStore.open(join(space.stateDir, 'state.db'));
    try {
      expect(store.activePlanForRepo(space.repo.dir)?.state).toBe('failed');
    } finally {
      store.close();
    }
  });
});

describe('the approved manifest is the only runtime source', () => {
  it('validates the recorded images rather than resolving fresh ones', async () => {
    const space = await workspace();
    await prepare(space);

    const rebuilt: RuntimeImages = {
      ...IMAGES,
      codex: { role: 'codex', id: `sha256:${'9'.repeat(64)}` },
    };

    const result = await execute(
      parseCommand(
        ['run', space.manifestPath, '--repo', space.repo.dir, '--artifacts', space.artifactDir],
        space.env,
      ),
      {
        sweep: () => Promise.resolve(),
        resolveImages: () => Promise.resolve(rebuilt),
        coordinate: () => Promise.reject(new Error('should not run')),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({ error: 'runtime_changed' });
  });

  it('validates without a daemon when the manifest still matches', async () => {
    const space = await workspace();
    await prepare(space);

    const approved = await validateManifest(await loadManifest(space.manifestPath), {
      repoPath: space.repo.dir,
      resolveImages: () => Promise.resolve(IMAGES),
    });

    expect(approved.images).toEqual(IMAGES);
    expect(await readFile(space.manifestPath, 'utf8')).toContain(IMAGES.setup.id);
  });
});
