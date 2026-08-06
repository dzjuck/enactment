import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_BASE_ARGS,
  CLAUDE_CODING_PERMISSION_ARGS,
  CLAUDE_CODING_TOOLS,
  CLAUDE_DIAGNOSIS_TOOLS,
  CLAUDE_LAUNCHER,
  CLAUDE_PRINT_FLAG,
} from '../../src/adapters/claude/policy.js';
import { compileCodexPolicy } from '../../src/adapters/codex/policy.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import {
  bundleRootFor,
  contextDirFor,
  documentationHash,
  writeBundle,
} from '../../src/docs/bundle.js';
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
import {
  NORMAL_ROUTES,
  PROFILE_IDS,
  PROFILES,
  STRONGER_PROFILE_ID,
} from '../../src/routing/profiles.js';
import { createRepo, createTargetRepo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { planDocument } from '../helpers/plan.js';

const IMAGES: RuntimeImages = {
  codex: { role: 'codex', id: `sha256:${'a'.repeat(64)}` },
  claude: { role: 'claude', id: `sha256:${'e'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'b'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'c'.repeat(64)}` },
  reviewer: { role: 'reviewer', id: `sha256:${'8'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'d'.repeat(64)}` },
};

const BASE = { branch: 'main', commit: 'f'.repeat(40) };

const STEP = [
  'type: code_behavior',
  'complexity: low',
  'risk: standard',
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

/** Appended under the step's `verification:` key; indentation matches `STEP`. */
const RUNTIME_LINES = [
  '  runtime:',
  '    start_command: ["node", "src/server.js"]',
  '    port: 3000',
  '    readiness_path: /health',
  '    behavioral_commands: [["node", "harness-checks/runtime-check.mjs"]]',
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
      codex_image_id: IMAGES.codex.id,
      claude_image_id: IMAGES.claude.id,
      verifier_image_id: IMAGES.verifier.id,
      reviewer_image_id: IMAGES.reviewer.id,
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

  it('changes the plan hash when step complexity changes', async () => {
    const dir = await workspace();
    const manifestPath = join(dir, 'execution-manifest.yml');
    const low = await build(await writePlan(dir, STEP, 'low.yml'), manifestPath);
    const high = await build(
      await writePlan(
        dir,
        STEP.map((line) => (line === 'complexity: low' ? 'complexity: high' : line)),
        'high.yml',
      ),
      manifestPath,
    );

    expect(high.inputs.plan_hash).not.toBe(low.inputs.plan_hash);
  });

  it('changes the plan hash when only step risk changes, so risk needs re-approval', async () => {
    const dir = await workspace();
    const manifestPath = join(dir, 'execution-manifest.yml');
    const standard = await build(await writePlan(dir, STEP, 'standard.yml'), manifestPath);
    const high = await build(
      await writePlan(
        dir,
        STEP.map((line) => (line === 'risk: standard' ? 'risk: high' : line)),
        'high.yml',
      ),
      manifestPath,
    );

    expect(high.inputs.plan_hash).not.toBe(standard.inputs.plan_hash);
  });

  it('contains the complete fixed provider and routing contract', () => {
    const policy = activePolicy();
    const codex = compileCodexPolicy({
      prompt: '<prompt>',
      workdir: '/workspace',
      model: '<profile-model>',
      reasoningEffort: '<profile-effort>',
    });

    expect(policy.providers).toEqual({
      codex: {
        version: '0.146.0',
        allowed_hosts: ['chatgpt.com'],
        authentication_mode: 'rotating_subscription_json',
        policy: {
          files: codex.files,
          args: codex.args,
          env: codex.env,
          stdin: codex.stdin,
        },
      },
      claude: {
        version: '2.1.221',
        allowed_hosts: ['api.anthropic.com'],
        authentication_mode: 'static_subscription_token',
        policy: {
          launcher: CLAUDE_LAUNCHER,
          print_flag: CLAUDE_PRINT_FLAG,
          base_args: [...CLAUDE_BASE_ARGS],
          coding_tools: [...CLAUDE_CODING_TOOLS],
          coding_permission_args: [...CLAUDE_CODING_PERMISSION_ARGS],
          diagnosis_tools: CLAUDE_DIAGNOSIS_TOOLS,
        },
      },
    });
    expect(policy.routing).toEqual({
      profiles: PROFILE_IDS.map((id) => PROFILES[id]),
      normal_routes: NORMAL_ROUTES,
      stronger_profile: STRONGER_PROFILE_ID,
    });
  });

  it('changes the policy hash for every provider, profile, route, and dependency change', () => {
    const baseline = policyHash(activePolicy());
    const changed = (mutate: (policy: ReturnType<typeof activePolicy>) => void): string => {
      const policy = structuredClone(activePolicy());
      mutate(policy);
      return policyHash(policy);
    };

    const mutations = [
      changed((policy) => {
        policy.providers.codex.version = '0.0.0';
      }),
      changed((policy) => {
        policy.providers.claude.version = '0.0.0';
      }),
      changed((policy) => {
        policy.providers.codex.allowed_hosts = ['example.com'];
      }),
      changed((policy) => {
        policy.providers.claude.allowed_hosts = ['example.com'];
      }),
      changed((policy) => {
        policy.providers.codex.policy = { changed: true };
      }),
      changed((policy) => {
        policy.providers.claude.policy = { changed: true };
      }),
      changed((policy) => {
        const first = policy.routing.profiles[0];
        if (first === undefined) throw new Error('active policy has no profiles');
        first.model = 'changed-model';
      }),
      changed((policy) => {
        policy.routing.normal_routes.low = 'codex-deep';
      }),
      changed((policy) => {
        policy.routing.stronger_profile = 'codex-fast';
      }),
      changed((policy) => {
        policy.dependencies.lifecycle_scripts = 'allowed';
      }),
      changed((policy) => {
        policy.dependencies.install_command = ['npm', 'install'];
      }),
    ];

    expect(mutations.every((hash) => hash !== baseline)).toBe(true);
  });

  it('contains the fixed runtime-verification policy', () => {
    expect(activePolicy().runtime).toEqual({
      host: '0.0.0.0',
      readiness_timeout_seconds: 60,
      command_timeout_seconds: 600,
      probe: 'http-get-200',
      environment: ['HOST', 'PORT', 'HARNESS_APP_URL'],
      network: 'internal',
    });
  });

  it('changes the policy hash for every fixed runtime policy change', () => {
    const baseline = policyHash(activePolicy());
    const changed = (mutate: (policy: ReturnType<typeof activePolicy>) => void): string => {
      const policy = structuredClone(activePolicy());
      mutate(policy);
      return policyHash(policy);
    };

    const mutations = [
      changed((policy) => {
        policy.runtime.host = '127.0.0.1';
      }),
      changed((policy) => {
        policy.runtime.readiness_timeout_seconds = 90;
      }),
      changed((policy) => {
        policy.runtime.command_timeout_seconds = 900;
      }),
      changed((policy) => {
        policy.runtime.probe = 'tcp-connect';
      }),
      changed((policy) => {
        policy.runtime.environment = ['HOST', 'PORT'];
      }),
      changed((policy) => {
        policy.runtime.network = 'egress';
      }),
    ];

    expect(mutations.every((hash) => hash !== baseline)).toBe(true);
  });

  it.each([
    ['the port', (yaml: string) => yaml.replace('port: 3000', 'port: 3001')],
    ['the readiness path', (yaml: string) => yaml.replace('readiness_path: /health', 'readiness_path: /ready')],
    ['the start command', (yaml: string) => yaml.replace('"src/server.js"', '"src/main.js"')],
    [
      'a behavioral command',
      (yaml: string) => yaml.replace('runtime-check.mjs', 'other-check.mjs'),
    ],
  ])('changes the plan hash when %s in the runtime block changes', async (_label, mutate) => {
    const dir = await workspace();
    const manifestPath = join(dir, 'execution-manifest.yml');
    const step = [...STEP, ...RUNTIME_LINES];

    const baseline = await build(await writePlan(dir, step, 'a.yml'), manifestPath);
    const changed = await build(
      await writePlan(dir, step.map(mutate), 'b.yml'),
      manifestPath,
    );

    expect(changed.inputs.plan_hash).not.toBe(baseline.inputs.plan_hash);
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
    ['an unknown field', (yaml: string) => `${yaml}    scanner: claude\n`, 'scanner'],
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

  it('rejects an old five-image manifest rather than defaulting the reviewer image', async () => {
    const dir = await workspace();
    const planFile = await writePlan(dir);
    const manifestPath = join(dir, 'execution-manifest.yml');
    await writeManifest(manifestPath, await build(planFile, manifestPath));
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, 'utf8')).replace(/\s*reviewer_image_id: sha256:[0-9a-f]+/, ''),
    );

    await expect(loadManifest(manifestPath)).rejects.toThrow(ManifestConfigError);
    await expect(loadManifest(manifestPath)).rejects.toThrow(/reviewer_image_id/);
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

  it.each(['codex', 'claude', 'reviewer'] as const)(
    'rejects a changed %s runtime image ID before anything executes',
    async (role) => {
      const { repo, manifestPath } = await approved();

      const error = await validateManifest(await loadManifest(manifestPath), {
        repoPath: repo.dir,
        resolveImages: () =>
          Promise.resolve({ ...IMAGES, [role]: { role, id: `sha256:${'9'.repeat(64)}` } }),
      }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ApprovalError);
      expect((error as ApprovalError).reason).toBe('runtime_changed');
      expect((error as ApprovalError).message).toContain(`${role}_image_id`);
    },
  );

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

  describe('documentation', () => {
    const SOURCES = [
      { url: 'https://example.com/openapi.json', path: 'example/openapi.json' },
      { url: 'https://example.com/guide.md', path: 'guide.md' },
    ];

    async function documentedPlan(dir: string): Promise<string> {
      const planFile = join(dir, 'plan.yml');
      await writeFile(planFile, planDocument(STEP, { documentation: SOURCES }));

      await writeBundle(
        bundleRootFor(planFile),
        SOURCES.map((source, index) => ({
          ...source,
          bytes: Buffer.from(`body ${String(index)}\n`, 'utf8'),
          fetchedAt: '2026-01-01T00:00:00.000Z',
        })),
      );

      return planFile;
    }

    async function approvedDocumented(): Promise<{
      repo: TargetRepo;
      manifestPath: string;
      planFile: string;
    }> {
      const repo = await createTargetRepo();
      repos.push(repo.dir);
      const dir = await workspace();
      const planFile = await documentedPlan(dir);
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

      return { repo, manifestPath, planFile };
    }

    function approve(
      loaded: Awaited<ReturnType<typeof loadManifest>>,
      repoPath: string,
      resolveImages: () => Promise<RuntimeImages> = () => Promise.resolve(IMAGES),
    ): Promise<unknown> {
      return validateManifest(loaded, { repoPath, resolveImages }).catch(
        (thrown: unknown) => thrown,
      );
    }

    it('records the bundle hash for a documented plan and omits the field otherwise', async () => {
      const documented = await documentedPlan(await workspace());
      const plain = await writePlan(await workspace());

      const withDocs = await build(documented, join(documented, '..', 'm.yml'));
      const without = await build(plain, join(plain, '..', 'm.yml'));

      expect(withDocs.inputs.documentation_hash).toBe(
        await documentationHash(contextDirFor(bundleRootFor(documented))),
      );
      expect(without.inputs).not.toHaveProperty('documentation_hash');
    });

    it('refuses to prepare a documented plan whose bundle has not been downloaded', async () => {
      const dir = await workspace();
      const planFile = join(dir, 'plan.yml');
      await writeFile(planFile, planDocument(STEP, { documentation: SOURCES }));

      const error = await build(planFile, join(dir, 'm.yml')).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ApprovalError);
      expect((error as Error).message).toMatch(/harness docs/);
    });

    it('contains the fixed documentation policy and hashes every part of it', () => {
      expect(activePolicy().documentation).toEqual({
        transport: 'connect-proxy',
        timeout_seconds: 600,
        maximum_download_mb: 50,
        redirects: 'rejected',
        content: 'utf8-text-no-html',
        mount: '/context',
        mount_mode: 'read-only',
        consumers: ['agent'],
      });

      const baseline = policyHash(activePolicy());
      const changed = (mutate: (policy: ReturnType<typeof activePolicy>) => void): string => {
        const policy = structuredClone(activePolicy());
        mutate(policy);
        return policyHash(policy);
      };

      const mutations = [
        changed((policy) => {
          policy.documentation.timeout_seconds = 900;
        }),
        changed((policy) => {
          policy.documentation.maximum_download_mb = 100;
        }),
        changed((policy) => {
          policy.documentation.mount = '/docs';
        }),
        changed((policy) => {
          policy.documentation.consumers = ['agent', 'verifier'];
        }),
      ];

      expect(mutations.every((hash) => hash !== baseline)).toBe(true);
    });

    it('accepts an unchanged bundle and returns the directory the agent will mount', async () => {
      const { repo, manifestPath, planFile } = await approvedDocumented();

      const inputs = await validateManifest(await loadManifest(manifestPath), {
        repoPath: repo.dir,
        resolveImages: () => Promise.resolve(IMAGES),
      });

      expect(inputs.documentation).toEqual({
        contextDir: contextDirFor(bundleRootFor(planFile)),
        hash: await documentationHash(contextDirFor(bundleRootFor(planFile))),
      });
    });

    it.each([
      [
        'a deleted bundle',
        async (planFile: string) => rm(bundleRootFor(planFile), { recursive: true, force: true }),
      ],
      [
        'an edited file',
        async (planFile: string) =>
          writeFile(
            join(bundleRootFor(planFile), 'context', 'files', 'guide.md'),
            'tampered\n',
          ),
      ],
      [
        'an extra file',
        async (planFile: string) =>
          writeFile(join(bundleRootFor(planFile), 'context', 'files', 'extra.md'), 'extra\n'),
      ],
    ])('rejects %s as documentation_changed', async (_label, damage) => {
      const { repo, manifestPath, planFile } = await approvedDocumented();
      const loaded = await loadManifest(manifestPath);
      await damage(planFile);

      const error = await approve(loaded, repo.dir);

      expect(error).toBeInstanceOf(ApprovalError);
      expect((error as ApprovalError).reason).toBe('documentation_changed');
      expect((error as Error).message).toMatch(/docs|delete/i);
    });

    it('rejects a bundle whose content hash differs from the approved one', async () => {
      const { repo, manifestPath } = await approvedDocumented();
      const loaded = await loadManifest(manifestPath);
      loaded.manifest.inputs.documentation_hash = `sha256:${'0'.repeat(64)}`;

      const error = await approve(loaded, repo.dir);

      expect(error).toBeInstanceOf(ApprovalError);
      expect((error as ApprovalError).reason).toBe('documentation_changed');
    });

    it('rejects an approval whose hash and plan disagree about documentation existing', async () => {
      const { repo, manifestPath } = await approvedDocumented();

      const withoutHash = await loadManifest(manifestPath);
      delete withoutHash.manifest.inputs.documentation_hash;
      expect((await approve(withoutHash, repo.dir) as ApprovalError).reason).toBe(
        'documentation_changed',
      );

      const { repo: plainRepo, manifestPath: plainManifest } = await approved();
      const withHash = await loadManifest(plainManifest);
      withHash.manifest.inputs.documentation_hash = `sha256:${'0'.repeat(64)}`;
      expect((await approve(withHash, plainRepo.dir) as ApprovalError).reason).toBe(
        'documentation_changed',
      );
    });

    it('checks the bundle before images and the base commit', async () => {
      const { manifestPath, planFile } = await approvedDocumented();
      const loaded = await loadManifest(manifestPath);
      await rm(bundleRootFor(planFile), { recursive: true, force: true });

      const error = await approve(loaded, '/definitely/not/a/repo', () =>
        Promise.reject(new Error('images were resolved')),
      );

      expect(error).toBeInstanceOf(ApprovalError);
      expect((error as ApprovalError).reason).toBe('documentation_changed');
    });

    it('ignores a stray bundle beside a plan that declares no documentation', async () => {
      const { repo, manifestPath } = await approved();
      const loaded = await loadManifest(manifestPath);
      await writeBundle(bundleRootFor(loaded.planFile), [
        {
          url: 'https://example.com/stray.md',
          path: 'stray.md',
          bytes: Buffer.from('stray\n', 'utf8'),
          fetchedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);

      const inputs = await validateManifest(loaded, {
        repoPath: repo.dir,
        resolveImages: () => Promise.resolve(IMAGES),
      });

      expect(inputs.documentation).toBeUndefined();
    });
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
