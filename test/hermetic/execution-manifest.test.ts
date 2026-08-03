import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeImages } from '../../src/docker/images.js';
import {
  ApprovalError,
  ManifestConfigError,
  activePolicy,
  buildManifest,
  loadManifest,
  policyHash,
  validateManifest,
  writeManifest,
  type ExecutionManifest,
} from '../../src/plan/execution-manifest.js';
import { createRepo, createTargetRepo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { planDocument } from '../helpers/plan.js';

const IMAGES: RuntimeImages = {
  agent: { role: 'agent', id: `sha256:${'a'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'b'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'c'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'d'.repeat(64)}` },
};

const BASE = { branch: 'main', commit: 'f'.repeat(40) };

const STEP = [
  'type: code_behavior',
  'id: add-slugify',
  'observable_behavior: Add slugify behavior.',
  'implementation_paths:',
  '  - src/slugify.js',
  'test_paths:',
  '  - test/slugify.test.js',
  'expected_test_ids:',
  '  - slugify lowercases and hyphenates',
  'verification:',
  '  test_command: ["npx", "--no-install", "vitest", "run"]',
];

const dirs: string[] = [];
const repos: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(repos.splice(0).map((dir) => removeRepo(dir)));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-manifest-'));
  dirs.push(dir);
  return dir;
}

async function writePlan(dir: string, lines: string[] = STEP, name = 'plan.yml'): Promise<string> {
  const path = join(dir, name);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, planDocument(lines));
  return path;
}

function build(planFile: string, manifestPath: string): Promise<ExecutionManifest> {
  return buildManifest({
    planFile,
    manifestPath,
    repoPath: '/unused',
    resolveImages: () => Promise.resolve(IMAGES),
    resolveBase: () => Promise.resolve(BASE),
  });
}

describe('candidate execution manifest', () => {
  it('produces byte-identical data and hashes from identical resolved inputs', async () => {
    const dir = await workspace();
    const planFile = await writePlan(dir);
    const manifestPath = join(dir, 'execution-manifest.yml');

    const first = await build(planFile, manifestPath);
    const second = await build(planFile, manifestPath);

    expect(second).toEqual(first);

    await writeManifest(manifestPath, first);
    const firstBytes = await readFile(manifestPath);
    await writeManifest(manifestPath, second);

    expect(await readFile(manifestPath)).toEqual(firstBytes);
  });

  it('records the plan relative to the manifest, the approved base, and the runtime', async () => {
    const dir = await workspace();
    const planFile = await writePlan(dir, STEP, 'plans/plan.yml');
    const manifestPath = join(dir, 'execution-manifest.yml');

    const manifest = await build(planFile, manifestPath);

    expect(manifest.plan_file).toBe('plans/plan.yml');
    expect(manifest.repository).toEqual({ base_branch: 'main', base_commit: BASE.commit });
    expect(manifest.runtime).toEqual({
      harness_version: '0.1.0',
      agent_image_id: IMAGES.agent.id,
      verifier_image_id: IMAGES.verifier.id,
      setup_image_id: IMAGES.setup.id,
      proxy_image_id: IMAGES.proxy.id,
    });
    expect(manifest.inputs.plan_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.inputs.policy_hash).toBe(policyHash(activePolicy()));
  });

  it.each([
    ['a verification command', ['  commands: [["npm", "run", "typecheck"]]']],
    ['an implementation scope', ['  - src/other.js']],
    ['a closure path', ['  closure_paths: ["package.json"]']],
    ['a quarantine entry', ['baseline:', '  known_flaky_tests: ["flaky one"]']],
  ])('changes the plan hash when %s changes', async (_label, extra) => {
    const dir = await workspace();
    const manifestPath = join(dir, 'execution-manifest.yml');

    const baseline = await build(await writePlan(dir, STEP, 'a.yml'), manifestPath);
    const changed = await build(
      await writePlan(
        dir,
        // Closure and command lines belong under `verification:`; the scope line under
        // `implementation_paths:`. Appending keeps each variant a single-line delta.
        extra[0]?.startsWith('  - ') === true
          ? [...STEP.slice(0, 5), ...extra, ...STEP.slice(5)]
          : [...STEP, ...extra],
        'b.yml',
      ),
      manifestPath,
    );

    expect(changed.inputs.plan_hash).not.toBe(baseline.inputs.plan_hash);
  });

  it('changes the policy hash for a network or dependency policy change', async () => {
    const policy = activePolicy();

    expect(policyHash({ ...policy, network: { ...policy.network, allowed_hosts: ['example.com'] } }))
      .not.toBe(policyHash(policy));
    expect(
      policyHash({
        ...policy,
        network: { ...policy.network, codex_version: '0.0.0' },
      }),
    ).not.toBe(policyHash(policy));
    expect(
      policyHash({
        ...policy,
        dependencies: { ...policy.dependencies, lifecycle_scripts: 'allowed' },
      }),
    ).not.toBe(policyHash(policy));
    expect(
      policyHash({
        ...policy,
        dependencies: { ...policy.dependencies, install_command: ['npm', 'install'] },
      }),
    ).not.toBe(policyHash(policy));
  });

  it('does not touch Git', async () => {
    const repo: TargetRepo = await createTargetRepo();
    repos.push(repo.dir);
    const dir = await workspace();
    const planFile = await writePlan(dir);

    const before = await git(repo.dir, ['status', '--porcelain=v1', '--branch']);
    const refsBefore = await git(repo.dir, ['for-each-ref', '--format=%(refname) %(objectname)']);

    const manifest = await buildManifest({
      planFile,
      manifestPath: join(dir, 'execution-manifest.yml'),
      repoPath: repo.dir,
      resolveImages: () => Promise.resolve(IMAGES),
    });

    expect(manifest.repository.base_commit).toBe(repo.commit);
    expect(manifest.repository.base_branch).toBe('main');
    expect(await git(repo.dir, ['status', '--porcelain=v1', '--branch'])).toBe(before);
    expect(await git(repo.dir, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(
      refsBefore,
    );
  });
});

describe('execution manifest loading', () => {
  it('loads the plan through a path relative to the manifest', async () => {
    const dir = await workspace();
    const planFile = await writePlan(dir, STEP, 'plans/plan.yml');
    const manifestPath = join(dir, 'execution-manifest.yml');
    await writeManifest(manifestPath, await build(planFile, manifestPath));

    const loaded = await loadManifest(manifestPath);

    expect(loaded.planFile).toBe(planFile);
    expect(loaded.plan.id).toBe('harness-test-plan');
    expect(loaded.hash).toBe(loaded.manifest.inputs.plan_hash);
  });

  it.each([
    [
      'a malformed hash',
      (yaml: string) => yaml.replace(/plan_hash: sha256:[0-9a-f]+/, 'plan_hash: deadbeef'),
      'plan_hash',
    ],
    ['an unknown field', (yaml: string) => `${yaml}    reviewer: claude\n`, 'reviewer'],
    [
      'an unknown version',
      (yaml: string) => yaml.replace('version: 1', 'version: 2'),
      'version',
    ],
  ])('rejects %s', async (_label, mutate, mentioned) => {
    const dir = await workspace();
    const planFile = await writePlan(dir);
    const manifestPath = join(dir, 'execution-manifest.yml');
    await writeManifest(manifestPath, await build(planFile, manifestPath));
    await writeFile(manifestPath, mutate(await readFile(manifestPath, 'utf8')));

    await expect(loadManifest(manifestPath)).rejects.toThrow(ManifestConfigError);
    await expect(loadManifest(manifestPath)).rejects.toThrow(new RegExp(mentioned));
  });

  it('rejects a plan whose bytes no longer match the approved hash', async () => {
    const dir = await workspace();
    const planFile = await writePlan(dir);
    const manifestPath = join(dir, 'execution-manifest.yml');
    await writeManifest(manifestPath, await build(planFile, manifestPath));

    await writeFile(planFile, `${await readFile(planFile, 'utf8')}\n`);

    const error = await loadManifest(manifestPath).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApprovalError);
    expect((error as ApprovalError).reason).toBe('plan_changed');
  });
});

describe('execution manifest approval', () => {
  async function approved(): Promise<{ repo: TargetRepo; manifestPath: string }> {
    const repo = await createTargetRepo();
    repos.push(repo.dir);
    const dir = await workspace();
    const planFile = await writePlan(dir);
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

    return { repo, manifestPath };
  }

  it('returns the approved inputs the run executes from', async () => {
    const { repo, manifestPath } = await approved();

    const inputs = await validateManifest(await loadManifest(manifestPath), {
      repoPath: repo.dir,
      resolveImages: () => Promise.resolve(IMAGES),
    });

    expect(inputs.baseCommit).toBe(repo.commit);
    expect(inputs.baseBranch).toBe('main');
    expect(inputs.images).toEqual(IMAGES);
    expect(inputs.plan.steps).toHaveLength(1);
  });

  it('rejects an approved base commit the repository cannot resolve', async () => {
    const { manifestPath } = await approved();
    // A different repository, not a second copy: the fixture repos are built with pinned
    // author and committer dates, so two copies of the same fixture share a commit SHA.
    const other = await createRepo('m2-repo');
    repos.push(other.dir);

    const error = await validateManifest(await loadManifest(manifestPath), {
      repoPath: other.dir,
      resolveImages: () => Promise.resolve(IMAGES),
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApprovalError);
    expect((error as ApprovalError).reason).toBe('base_unresolvable');
  });

  it('rejects a changed runtime image ID before anything executes', async () => {
    const { repo, manifestPath } = await approved();

    const error = await validateManifest(await loadManifest(manifestPath), {
      repoPath: repo.dir,
      resolveImages: () =>
        Promise.resolve({ ...IMAGES, verifier: { role: 'verifier', id: `sha256:${'9'.repeat(64)}` } }),
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApprovalError);
    expect((error as ApprovalError).reason).toBe('runtime_changed');
    expect((error as ApprovalError).message).toContain('verifier_image_id');
  });

  it('rejects a changed harness version', async () => {
    const { repo, manifestPath } = await approved();
    const loaded = await loadManifest(manifestPath);
    loaded.manifest.runtime.harness_version = '0.0.9';

    const error = await validateManifest(loaded, {
      repoPath: repo.dir,
      resolveImages: () => Promise.resolve(IMAGES),
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApprovalError);
    expect((error as ApprovalError).reason).toBe('runtime_changed');
    expect((error as ApprovalError).message).toContain('harness_version');
  });

  it('rejects a policy hash that no longer describes the active policy', async () => {
    const { repo, manifestPath } = await approved();
    const loaded = await loadManifest(manifestPath);
    loaded.manifest.inputs.policy_hash = `sha256:${'0'.repeat(64)}`;

    const error = await validateManifest(loaded, {
      repoPath: repo.dir,
      resolveImages: () => Promise.resolve(IMAGES),
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApprovalError);
    expect((error as ApprovalError).reason).toBe('policy_changed');
  });
});
