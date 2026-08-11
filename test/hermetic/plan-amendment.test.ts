import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeImages } from '../../src/docker/images.js';
import { acceptChanges } from '../../src/git/accept.js';
import { runPlan, type CoordinatorOptions, type PlanReport } from '../../src/run/coordinator.js';
import type { RunReport, StepExecutionOptions } from '../../src/run/orchestrator.js';
import { parseCommand } from '../../src/run/options.js';
import { execute, type CommandResult } from '../../src/run/production.js';
import type { FinalVerificationResult } from '../../src/verify/final.js';
import { createM2Repo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';

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

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(repos.splice(0).map((dir) => removeRepo(dir)));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'enactment-amend-'));
  dirs.push(dir);
  return dir;
}

function planDocument(planId: string, stepIds: string[]): string {
  return [
    'version: 1',
    `id: ${planId}`,
    'steps:',
    ...stepIds.flatMap((id) => [
      '  - type: task',
      '    complexity: low',
      '    risk: standard',
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

/**
 * An executor that stands in for the model and the containers only.
 *
 * Acceptance is the real one, so the commit carries the real trailers and is built on the
 * step's parent — which is exactly what the amendment procedure depends on. Any step named in
 * `blocked` disputes its test contract instead, the ordinary reason a plan needs amending.
 */
function executor(
  repo: TargetRepo,
  blocked: string[] = [],
): (options: StepExecutionOptions) => Promise<RunReport> {
  return async (options) => {
    if (blocked.includes(options.step.id)) {
      return {
        status: 'failed',
        attempt: options.attempt,
        failedPhase: 'implementation',
        category: 'test_contract_disputed',
        message: 'the frozen tests describe behavior this step cannot implement',
      };
    }

    const content = Buffer.from(`${options.step.id}\n`);
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
      changes: [
        {
          kind: 'added',
          path: `${options.step.id}.txt`,
          entry: {
            path: `${options.step.id}.txt`,
            type: 'file',
            mode: 0o644,
            hash: 'unused',
            content,
          },
        },
      ],
    });

    await options.onEvent?.({ kind: 'candidate', snapshot: `sha256:${'e'.repeat(64)}` });
    await options.onEvent?.({ kind: 'accepting' });

    return {
      status: 'succeeded',
      attempt: options.attempt,
      commit: accepted.commit,
      branch: accepted.branch,
    };
  };
}

interface Operator {
  repo: TargetRepo;
  dir: string;
  artifactDir: string;
  env: NodeJS.ProcessEnv;
}

async function operator(): Promise<Operator> {
  const repo = await createM2Repo();
  repos.push(repo.dir);
  const dir = await scratch();

  return {
    repo,
    dir,
    artifactDir: join(dir, 'artifacts'),
    env: { ENACTMENT_STATE_DIR: join(dir, 'state') },
  };
}

/** The commands of the RUNBOOK amendment procedure, driven through the production CLI. */
function prepare(
  space: Operator,
  planFile: string,
  output: string,
  base?: string,
): Promise<CommandResult> {
  return execute(
    parseCommand(
      [
        'prepare',
        planFile,
        '--repo',
        space.repo.dir,
        '--output',
        output,
        ...(base === undefined ? [] : ['--base', base]),
      ],
      space.env,
    ),
    { resolveImages: () => Promise.resolve(IMAGES) },
  );
}

function run(space: Operator, manifestPath: string, blocked: string[] = []): Promise<CommandResult> {
  return execute(
    parseCommand(
      ['run', manifestPath, '--repo', space.repo.dir, '--artifacts', space.artifactDir],
      space.env,
    ),
    {
      // Only the model and the containers are stood in for: the coordinator, acceptance,
      // recovery, state and Git are the production ones.
      sweep: () => Promise.resolve(),
      resolveImages: () => Promise.resolve(IMAGES),
      coordinate: (options: CoordinatorOptions): Promise<PlanReport> =>
        runPlan(options, { execute: executor(space.repo, blocked), verifyFinal: passingFinal }),
    },
  );
}

function cancel(space: Operator, manifestPath: string): Promise<CommandResult> {
  return execute(
    parseCommand(
      ['cancel', manifestPath, '--repo', space.repo.dir, '--artifacts', space.artifactDir],
      space.env,
    ),
    {},
  );
}

describe('amending a blocked plan', () => {
  it('continues from the accepted work on a new revision branch', async () => {
    const space = await operator();

    const first = join(space.dir, 'plan.yml');
    await writeFile(first, planDocument('collector-dashboard', ['collect-runs', 'persist-runs']));
    const firstManifest = join(space.dir, 'execution-manifest.yml');

    expect((await prepare(space, first, firstManifest)).exitCode).toBe(0);

    // The plan accepts its first step and is blocked on its second.
    const blockedRun = await run(space, firstManifest, ['persist-runs']);
    expect(blockedRun.exitCode).toBe(1);
    expect(blockedRun.report).toMatchObject({
      state: 'failed',
      failure: { step: 'persist-runs', category: 'test_contract_disputed' },
    });

    const accepted = await git(space.repo.dir, ['rev-parse', 'enactment/collector-dashboard']);

    // Cancel releases the repository and names the commit to amend from.
    const cancelled = await cancel(space, firstManifest);
    expect(cancelled.exitCode).toBe(0);
    expect(cancelled.report).toMatchObject({
      state: 'cancelled',
      head: accepted,
      base: space.repo.commit,
    });

    // The amended plan: its own ID, only the step that still has to run.
    const second = join(space.dir, 'plan-r2.yml');
    await writeFile(second, planDocument('collector-dashboard-r2', ['persist-runs']));
    const secondManifest = join(space.dir, 'execution-manifest-r2.yml');

    const prepared = await prepare(space, second, secondManifest, accepted);
    expect(prepared.exitCode).toBe(0);
    expect(prepared.report).toMatchObject({ repository: { base_commit: accepted } });
    expect(prepared.report).not.toHaveProperty('warnings');

    const amended = await run(space, secondManifest);
    expect(amended.exitCode).toBe(0);
    expect(amended.report).toMatchObject({
      plan: 'collector-dashboard-r2',
      state: 'completed',
      branch: 'enactment/collector-dashboard-r2',
      baseCommit: accepted,
      finalVerification: { status: 'pass' },
    });

    // One linear chain: the newest branch contains the previous revision's accepted commit.
    const head = await git(space.repo.dir, ['rev-parse', 'enactment/collector-dashboard-r2']);
    expect(await git(space.repo.dir, ['rev-parse', `${head}^`])).toBe(accepted);
    await expect(
      git(space.repo.dir, ['merge-base', '--is-ancestor', accepted, head]),
    ).resolves.toBeDefined();

    // The previous revision's branch is untouched by any of it.
    expect(await git(space.repo.dir, ['rev-parse', 'enactment/collector-dashboard'])).toBe(
      accepted,
    );
  });

  it('warns when the amended plan still lists a step the base accepted', async () => {
    const space = await operator();

    const first = join(space.dir, 'plan.yml');
    await writeFile(first, planDocument('collector-dashboard', ['collect-runs', 'persist-runs']));
    const firstManifest = join(space.dir, 'execution-manifest.yml');
    expect((await prepare(space, first, firstManifest)).exitCode).toBe(0);
    await run(space, firstManifest, ['persist-runs']);
    const cancelled = await cancel(space, firstManifest);
    const accepted = (cancelled.report as { head: string }).head;

    // The mistake the procedure invites: the completed step is still declared.
    const second = join(space.dir, 'plan-r2.yml');
    await writeFile(
      second,
      planDocument('collector-dashboard-r2', ['collect-runs', 'persist-runs']),
    );

    const prepared = await prepare(
      space,
      second,
      join(space.dir, 'execution-manifest-r2.yml'),
      accepted,
    );

    expect(prepared.exitCode).toBe(0);
    expect((prepared.report as { warnings: { step: string }[] }).warnings).toEqual([
      expect.objectContaining({ step: 'collect-runs' }),
    ]);
  });
});
