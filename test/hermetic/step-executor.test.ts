import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../src/artifacts/store.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { idempotencyKey } from '../../src/git/idempotency.js';
import { loadPlan } from '../../src/plan/load.js';
import { PROFILES } from '../../src/routing/profiles.js';
import { runSinglePlanStep } from '../../src/run/bridge.js';
import type { StepExecutionOptions } from '../../src/run/orchestrator.js';
import { createTargetRepo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { planDocument } from '../helpers/plan.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const IMAGES: RuntimeImages = {
  codex: { role: 'codex', id: `sha256:${'a'.repeat(64)}` },
  claude: { role: 'claude', id: `sha256:${'e'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'b'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'c'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'d'.repeat(64)}` },
};

const STEP = [
  'type: task',
  'complexity: low',
  'risk: standard',
  'id: add-slugify',
  'observable_behavior: Implement the slugify function.',
  'implementation_paths:',
  '  - src/slugify.js',
  'verification:',
  '  commands:',
  '    - ["npx", "--no-install", "vitest", "run"]',
];

const dirs: string[] = [];
const repos: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(repos.splice(0).map((dir) => removeRepo(dir)));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-executor-'));
  dirs.push(dir);
  return dir;
}

async function fixture(stepIds = ['add-slugify']): Promise<{
  repo: TargetRepo;
  planFile: string;
}> {
  const repo = await createTargetRepo();
  repos.push(repo.dir);

  const dir = await scratch();
  const planFile = join(dir, 'plan.yml');
  const [first = 'add-slugify', ...rest] = stepIds;

  const extra = rest.flatMap((id) =>
    STEP.map((line, index) => {
      const body = line.startsWith('id:') ? `id: ${id}` : line;
      return index === 0 ? `  - ${body}` : `    ${body}`;
    }),
  );

  const document = planDocument(
    STEP.map((line) => (line.startsWith('id:') ? `id: ${first}` : line)),
    { id: 'slugify-plan' },
  );

  await writeFile(
    planFile,
    extra.length === 0
      ? document
      : document.replace('final_verification:', `${extra.join('\n')}\nfinal_verification:`),
  );

  return { repo, planFile };
}

describe('step executor inputs', () => {
  it('is handed every approved input and resolves none of them itself', async () => {
    const { repo, planFile } = await fixture();
    const artifactDir = await scratch();
    let seen: StepExecutionOptions | undefined;

    const { plan, hash: planHash } = await loadPlan(planFile);

    const report = await runSinglePlanStep(
      { planFile, repoPath: repo.dir, artifactDir },
      {
        resolveImages: () => Promise.resolve(IMAGES),
        execute: (options) => {
          seen = options;
          return Promise.resolve({ status: 'succeeded' as const, attempt: options.attempt });
        },
      },
    );

    expect(report.status).toBe('succeeded');
    expect(seen).toBeDefined();
    const options = seen as StepExecutionOptions;

    expect(options.step).toEqual(plan.steps[0]);
    expect(options.profile).toBe(PROFILES['codex-fast']);
    expect(options.planId).toBe('slugify-plan');
    expect(options.planHash).toBe(planHash);
    expect(options.images).toBe(IMAGES);
    expect(options.repoPath).toBe(repo.dir);
    expect(options.parentCommit).toBe(repo.commit);
    expect(options.baseBranch).toBe('main');
    expect(options.branch).toBe('ai-harness/slugify-plan');
    expect(options.branchExists).toBe(false);
    expect(options.attempt).toMatch(/\S/);
    expect(options.snapshots).toBeInstanceOf(ArtifactStore);
    expect(options.idempotencyKey).toBe(
      idempotencyKey({
        manifestHash: planHash,
        planId: 'slugify-plan',
        stepId: 'add-slugify',
        attempt: options.attempt,
        parentCommit: repo.commit,
      }),
    );
  });

  it('does not load a plan, resolve images, or read the repository head itself', async () => {
    const orchestrator = await readFile(join(SRC, 'run/orchestrator.ts'), 'utf8');

    expect(orchestrator).not.toContain('loadPlan');
    expect(orchestrator).not.toContain('resolveRuntimeImages');
    expect(orchestrator).not.toContain('resolveNormalProfile');
    expect(orchestrator).not.toContain('rev-parse');
  });

  it('refuses a multi-step plan before touching the executor', async () => {
    const { repo, planFile } = await fixture(['add-slugify', 'add-shout']);
    const artifactDir = await scratch();
    let started = false;

    const report = await runSinglePlanStep(
      { planFile, repoPath: repo.dir, artifactDir },
      {
        resolveImages: () => Promise.resolve(IMAGES),
        execute: () => {
          started = true;
          return Promise.resolve({ status: 'succeeded' as const, attempt: 'unused' });
        },
      },
    );

    expect(started).toBe(false);
    expect(report.status).toBe('failed');
    expect(report.message).toMatch(/2 steps/);
    expect(await git(repo.dir, ['for-each-ref', '--format=%(refname)', 'refs/heads/ai-harness/'])).toBe(
      '',
    );
  });
});
