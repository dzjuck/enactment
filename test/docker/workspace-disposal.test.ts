import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import type { RuntimeImage } from '../../src/docker/images.js';
import type { RunInjection } from '../../src/run/inject.js';
import { runTask, type RunPhase, type RunReport } from '../../src/run/orchestrator.js';
import { createTargetRepo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

const LABEL = 'ai-harness.attempt';

const SLUGIFY = `export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

/** Passes the diff but fails the fixture's test suite: a verifier-only failure. */
const WRONG_SLUGIFY = 'export function slugify() {\n  return "wrong";\n}\n';

interface Manifest {
  result: { status: string; phase?: string; category?: string; cleanup_errors?: string[] };
  snapshots?: { pre_agent?: string; implementation?: string };
  restoration?: unknown;
  repository?: Record<string, string>;
  runtime?: Record<string, string>;
  inputs?: Record<string, string>;
}

let repo: TargetRepo;
let root: string;
let taskFile: string;
let stub: RuntimeImage;
const dirs: string[] = [];

beforeAll(async () => {
  stub = await stubAgentImage();

  repo = await createTargetRepo();
  root = await mkdtemp(join(tmpdir(), 'harness-disposal-'));

  const source = join(root, 'codex-source');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, AUTH_FILE),
    JSON.stringify({ tokens: { access_token: 'sk-disposal-canary' } }),
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
      '  agent_seconds: 15',
      '  termination_grace_seconds: 2',
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

function stubEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    STUB_MODE: 'write',
    STUB_EVENTS: cannedEvents(),
    STUB_WRITE_PATH: 'src/slugify.js',
    STUB_WRITE_CONTENT: SLUGIFY,
    ...overrides,
  };
}

async function run(
  env: Record<string, string>,
  overrides: Partial<Parameters<typeof runTask>[0]> = {},
): Promise<{ report: RunReport; manifest: Manifest }> {
  const artifacts = await mkdtemp(join(tmpdir(), 'harness-artifacts-'));
  dirs.push(artifacts);

  const injection: RunInjection = { agent: stub, agentEnv: env, ...overrides.injection };

  const report = await runTask({
    taskFile,
    repoPath: repo.dir,
    artifactDir: artifacts,
    sourceCodexHome: join(root, 'codex-source'),
    storeDirectory: join(root, 'store'),
    dependencyCacheDirectory: join(root, 'deps'),
    ...overrides,
    injection,
  });

  const manifest = JSON.parse(
    await readFile(join(artifacts, 'run-manifest.json'), 'utf8'),
  ) as Manifest;

  return { report, manifest };
}

async function labelled(kind: 'container' | 'volume' | 'network', attempt: string) {
  const filter = `label=${LABEL}=${attempt}`;
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', filter]
      : [kind, 'ls', '-q', '--filter', filter];

  const { stdout } = await execa('docker', args);
  return stdout.split('\n').filter((line) => line !== '');
}

async function expectNoResources(attempt: string): Promise<void> {
  await expect(labelled('container', attempt)).resolves.toEqual([]);
  await expect(labelled('volume', attempt)).resolves.toEqual([]);
  await expect(labelled('network', attempt)).resolves.toEqual([]);
}

/**
 * Every way the agent block can leave the workspace dirty. In each of them the workspace is
 * deleted with the attempt: nothing reads it again, so nothing has to put it back first.
 */
describe('a dirty attempt workspace is thrown away with the attempt', () => {
  it('after an agent timeout', async () => {
    const { report, manifest } = await run(stubEnv({ STUB_MODE: 'hang' }));

    expect(report.status).toBe('failed');
    expect(report.category).toBe('agent_timeout');
    expect(manifest.restoration).toBeUndefined();
    await expectNoResources(report.attempt);
  }, 300_000);

  it('after a non-zero agent exit', async () => {
    const { report, manifest } = await run(stubEnv({ STUB_MODE: 'fail' }));

    expect(report.status).toBe('failed');
    expect(report.category).toBe('agent_failed');
    expect(manifest.restoration).toBeUndefined();
    await expectNoResources(report.attempt);
  }, 300_000);

  it('after malformed agent events', async () => {
    const { report, manifest } = await run(
      stubEnv({ STUB_MODE: 'malformed', STUB_EVENTS: 'this is not json' }),
    );

    expect(report.status).toBe('failed');
    expect(manifest.restoration).toBeUndefined();
    await expectNoResources(report.attempt);
  }, 300_000);

  it('after an error thrown between the agent and the diff', async () => {
    const { report, manifest } = await run(stubEnv(), {
      onPhase: (phase: RunPhase) => {
        if (phase === 'diff') throw new Error('injected post-agent failure');
      },
    });

    expect(report.status).toBe('failed');
    expect(report.failedPhase).toBe('diff');
    expect(manifest.restoration).toBeUndefined();
    await expectNoResources(report.attempt);
  }, 300_000);

  it.each([
    ['out of scope', { STUB_WRITE_PATH: 'elsewhere/other.js' }],
    ['a dependency manifest', { STUB_WRITE_PATH: 'package.json' }],
  ])('after a change %s', async (_label, overrides) => {
    const { report, manifest } = await run(stubEnv(overrides));

    expect(report.status).toBe('failed');
    expect(report.failedPhase).toBe('diff');
    expect(report.category).toBe('invalid_change');
    expect(manifest.restoration).toBeUndefined();
    await expectNoResources(report.attempt);
  }, 300_000);

  it('after an unsafe symlink', async () => {
    const { report, manifest } = await run(
      stubEnv({ STUB_SYMLINK_PATH: 'src/escape.js', STUB_SYMLINK_TARGET: '../../etc/passwd' }),
    );

    expect(report.status).toBe('failed');
    expect(report.category).toBe('invalid_change');
    expect(manifest.restoration).toBeUndefined();
    await expectNoResources(report.attempt);
  }, 300_000);

  it('after the agent made no changes at all', async () => {
    const { report, manifest } = await run({ STUB_MODE: 'events', STUB_EVENTS: cannedEvents() });

    expect(report.status).toBe('failed');
    expect(report.category).toBe('invalid_change');
    expect(manifest.restoration).toBeUndefined();
    await expectNoResources(report.attempt);
  }, 300_000);

  it('records the run identity in the failure manifest, and claims no restoration', async () => {
    const { manifest } = await run(stubEnv({ STUB_MODE: 'fail' }));

    // A failure manifest that lost the run's identity would make the evidence unusable.
    expect(manifest.repository?.base_commit).toBe(repo.commit);
    expect(manifest.runtime?.agent_image_id).toBe(stub.id);
    expect(manifest.inputs?.task_hash).toMatch(/^sha256:/);
    expect(manifest.restoration).toBeUndefined();
  }, 300_000);
});

describe('verifier failure touches only the disposable verifier copy', () => {
  it('leaves the implementation snapshot as the acceptance candidate', async () => {
    const { report, manifest } = await run(stubEnv({ STUB_WRITE_CONTENT: WRONG_SLUGIFY }));

    expect(report.status).toBe('failed');
    expect(report.failedPhase).toBe('verify');
    expect(report.category).toBe('verification_failed');

    expect(manifest.snapshots?.implementation).toMatch(/^sha256:/);
    expect(manifest.restoration).toBeUndefined();
  }, 300_000);

  it('leaves no verifier resources behind', async () => {
    const { report } = await run(stubEnv({ STUB_WRITE_CONTENT: WRONG_SLUGIFY }));

    await expectNoResources(report.attempt);
  }, 300_000);
});

describe('a successful run is unaffected', () => {
  it('snapshots the accepted implementation and commits exactly the validated files', async () => {
    const { report, manifest } = await run(stubEnv());

    expect(report.status).toBe('succeeded');
    expect(manifest.snapshots?.implementation).toMatch(/^sha256:/);

    const committed = await git(repo.dir, [
      'show',
      '--name-only',
      '--pretty=format:',
      report.commit ?? '',
    ]);
    expect(committed.split('\n').filter((line) => line !== '')).toEqual(['src/slugify.js']);

    await expectNoResources(report.attempt);
  }, 300_000);
});
