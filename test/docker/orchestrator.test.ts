import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import { resolveRuntimeImages, type RuntimeImage } from '../../src/docker/images.js';
import type { RunInjection } from '../../src/run/inject.js';
import { runTask, RUN_PHASES, type RunPhase, type RunReport } from '../../src/run/orchestrator.js';
import { createTargetRepo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { buildStubAgent, cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

const CANARY = 'sk-orchestrator-canary-77d3f19a';
const LABEL = 'ai-harness.attempt';

const SLUGIFY = `export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

let repo: TargetRepo;
let root: string;
let taskFile: string;
let stub: RuntimeImage;
let runnerScript: string;
const dirs: string[] = [];

/** The stub writes the implementation, so the whole pipeline can reach a real commit. */
function stubEnv(mode = 'write'): Record<string, string> {
  return {
    STUB_MODE: mode,
    STUB_EVENTS: cannedEvents(),
    STUB_WRITE_PATH: 'src/slugify.js',
    STUB_WRITE_CONTENT: SLUGIFY,
  };
}

/** The only seam a test may use: an explicit runtime identity, recorded like any other. */
function injection(mode = 'write'): RunInjection {
  return { agent: stub, agentEnv: stubEnv(mode) };
}

beforeAll(async () => {
  await buildStubAgent();
  await execa('npm', ['run', 'build']);
  stub = await stubAgentImage();

  repo = await createTargetRepo();
  root = await mkdtemp(join(tmpdir(), 'harness-run-'));

  const source = join(root, 'codex-source');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, AUTH_FILE),
    JSON.stringify({ tokens: { access_token: CANARY, refresh_token: `refresh-${CANARY}` } }),
  );

  taskFile = join(root, 'task.yml');
  await writeFile(
    taskFile,
    [
      'id: add-slugify',
      'prompt: Implement the slugify function in src/slugify.js',
      'implementation_paths:',
      '  - src/slugify.js',
      'verification:',
      '  commands:',
      '    - ["npx", "--no-install", "vitest", "run", "--config", "vitest.config.js"]',
      'timeouts:',
      '  connectivity_smoke_seconds: 20',
      '  agent_seconds: 120',
      '  termination_grace_seconds: 2',
      '',
    ].join('\n'),
  );

  // The production CLI has no image or environment override, so the interrupt test drives
  // `runTask` in a child process of its own rather than through an escape hatch.
  runnerScript = join(root, 'run-with-stub.mjs');
  await writeFile(
    runnerScript,
    [
      `import { runTask } from ${JSON.stringify(join(process.cwd(), 'dist/run/orchestrator.js'))};`,
      'const controller = new AbortController();',
      "for (const signal of ['SIGINT', 'SIGTERM']) {",
      '  process.on(signal, () => { controller.abort(); });',
      '}',
      'const report = await runTask({',
      '  ...JSON.parse(process.env.HARNESS_TEST_RUN),',
      '  signal: controller.signal,',
      '});',
      "process.exit(report.status === 'succeeded' ? 0 : 1);",
      '',
    ].join('\n'),
  );
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function labelled(kind: 'container' | 'volume' | 'network'): Promise<string[]> {
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', `label=${LABEL}`]
      : [kind, 'ls', '-q', '--filter', `label=${LABEL}`];

  const { stdout } = await execa('docker', args);
  return stdout.split('\n').filter((line) => line !== '');
}

async function artifactDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-artifacts-'));
  dirs.push(dir);
  return dir;
}

async function run(
  overrides: Partial<Parameters<typeof runTask>[0]> = {},
): Promise<{ report: RunReport; artifacts: string }> {
  const artifacts = await artifactDir();

  const report = await runTask({
    taskFile,
    repoPath: repo.dir,
    artifactDir: artifacts,
    sourceCodexHome: join(root, 'codex-source'),
    storeDirectory: join(root, 'store'),
    dependencyCacheDirectory: join(root, 'deps'),
    injection: injection(),
    ...overrides,
  });

  return { report, artifacts };
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

describe('orchestrator', () => {
  it('drives every phase to a commit with a complete artifact set', async () => {
    const { report, artifacts } = await run();

    expect(report.status).toBe('succeeded');
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);

    const message = await git(repo.dir, ['log', '-1', '--format=%B', report.commit ?? '']);
    expect(message).toContain('AI-Harness-Task: add-slugify');

    const files = (await walk(artifacts)).map((path) => path.replace(`${artifacts}/`, ''));
    expect(files).toEqual(
      expect.arrayContaining([
        'run-manifest.json',
        'prompt.txt',
        'agent-events.jsonl',
        'verification.json',
        'source-diff.json',
        'proxy-records.jsonl',
      ]),
    );
    expect(files.some((path) => path.startsWith('logs/'))).toBe(true);
    expect(files.some((path) => path.startsWith('snapshots/'))).toBe(true);
  }, 900_000);

  it('runs the phases in order, with the smoke test ahead of the agent', async () => {
    const seen: RunPhase[] = [];
    await run({ onPhase: (phase) => void seen.push(phase) });

    expect(seen).toEqual(RUN_PHASES.filter((phase) => seen.includes(phase)));
    expect(seen.indexOf('connectivity')).toBeLessThan(seen.indexOf('agent'));
    expect(seen.indexOf('agent')).toBeLessThan(seen.indexOf('verify'));
    expect(seen.indexOf('verify')).toBeLessThan(seen.indexOf('commit'));
  }, 900_000);

  it.each(RUN_PHASES.filter((phase) => phase !== 'commit'))(
    'reports a failure injected in the %s phase and commits nothing',
    async (phase) => {
      const before = await git(repo.dir, ['rev-list', '--all', '--count']);

      const { report } = await run({
        onPhase: (current) => {
          if (current === phase) throw new Error(`injected ${phase} failure`);
        },
      });

      expect(report.status).toBe('failed');
      expect(report.failedPhase).toBe(phase);
      expect(report.commit).toBeUndefined();
      expect(await git(repo.dir, ['rev-list', '--all', '--count'])).toBe(before);

      await expect(labelled('container')).resolves.toEqual([]);
      await expect(labelled('volume')).resolves.toEqual([]);
      await expect(labelled('network')).resolves.toEqual([]);
    },
    900_000,
  );

  it('classifies an agent timeout and restores the pre-invocation workspace', async () => {
    const { report, artifacts } = await run({ injection: injection('hang') });

    expect(report.status).toBe('failed');
    expect(report.failedPhase).toBe('agent');
    expect(report.category).toBe('agent_timeout');
    expect(report.commit).toBeUndefined();

    const manifest = JSON.parse(
      await readFile(join(artifacts, 'run-manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect((manifest.result as Record<string, unknown>).category).toBe('agent_timeout');
  }, 900_000);

  it('leaves no attempt-labelled containers, volumes or networks behind', async () => {
    await run();

    await expect(labelled('container')).resolves.toEqual([]);
    await expect(labelled('volume')).resolves.toEqual([]);
    await expect(labelled('network')).resolves.toEqual([]);
  }, 900_000);

  it('records the §20 manifest fields', async () => {
    const { artifacts } = await run();

    const manifest = JSON.parse(await readFile(join(artifacts, 'run-manifest.json'), 'utf8')) as {
      repository: { base_branch: string; base_commit: string };
      inputs: Record<string, string>;
      runtime: Record<string, string>;
    };

    expect(manifest.repository.base_branch).toBe('main');
    expect(manifest.repository.base_commit).toBe(repo.commit);
    expect(manifest.inputs.task_hash).toMatch(/^sha256:/);
    expect(manifest.inputs.export_hash).toMatch(/^sha256:/);
    expect(manifest.inputs.network_policy_hash).toMatch(/^sha256:/);
    expect(manifest.inputs.dependency_cache_key).toMatch(/^sha256:/);
    expect(manifest.runtime.agent_image_digest).toMatch(/^sha256:/);
    expect(manifest.runtime.verifier_image_digest).toMatch(/^sha256:/);
    expect(manifest.runtime.setup_image_digest).toMatch(/^sha256:/);
    expect(manifest.runtime.proxy_image_digest).toMatch(/^sha256:/);
  }, 900_000);

  it('records the digest of the image it actually ran, not the production agent pin', async () => {
    const { artifacts } = await run();
    const production = await resolveRuntimeImages();

    const manifest = JSON.parse(await readFile(join(artifacts, 'run-manifest.json'), 'utf8')) as {
      runtime: Record<string, string>;
    };

    expect(manifest.runtime.agent_image_digest).toBe(stub.digest);
    expect(manifest.runtime.agent_image_digest).not.toBe(production.agent.digest);

    // Every role the injection did not replace is still the production identity.
    expect(manifest.runtime.verifier_image_digest).toBe(production.verifier.digest);
    expect(manifest.runtime.setup_image_digest).toBe(production.setup.digest);
    expect(manifest.runtime.proxy_image_digest).toBe(production.proxy.digest);
  }, 900_000);

  it('writes no raw authentication material into the artifact tree', async () => {
    const { artifacts } = await run();

    for (const file of await walk(artifacts)) {
      expect(await readFile(file, 'utf8')).not.toContain(CANARY);
    }
  }, 900_000);

  it('tears down every attempt resource when the run is interrupted', async () => {
    const artifacts = await artifactDir();

    const child = execa('node', [runnerScript], {
      reject: false,
      env: {
        HARNESS_TEST_RUN: JSON.stringify({
          taskFile,
          repoPath: repo.dir,
          artifactDir: artifacts,
          sourceCodexHome: join(root, 'codex-source'),
          storeDirectory: join(root, 'store'),
          dependencyCacheDirectory: join(root, 'deps'),
          injection: injection(),
        }),
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    child.kill('SIGINT');
    await child;

    await expect(labelled('container')).resolves.toEqual([]);
    await expect(labelled('volume')).resolves.toEqual([]);
    await expect(labelled('network')).resolves.toEqual([]);
  }, 900_000);
});
