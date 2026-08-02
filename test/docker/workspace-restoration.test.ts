import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import type { RuntimeImage } from '../../src/docker/images.js';
import type { RunInjection } from '../../src/run/inject.js';
import { runTask, type RunPhase, type RunReport } from '../../src/run/orchestrator.js';
import { createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

const SLUGIFY = `export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

/** Passes the diff but fails the fixture's test suite: a verifier-only failure. */
const WRONG_SLUGIFY = 'export function slugify() {\n  return "wrong";\n}\n';

interface RestorationEvidence {
  trigger: string;
  pre_agent: string;
  restored: string;
}

interface Manifest {
  result: { status: string; phase?: string; category?: string; cleanup_errors?: string[] };
  snapshots?: { pre_agent?: string; implementation?: string };
  restoration?: RestorationEvidence;
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
  root = await mkdtemp(join(tmpdir(), 'harness-restore-'));

  const source = join(root, 'codex-source');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, AUTH_FILE),
    JSON.stringify({ tokens: { access_token: 'sk-restore-canary' } }),
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

/** The restored workspace must be byte-identical to the pre-agent snapshot, not merely near it. */
function expectRestored(manifest: Manifest, trigger: string): void {
  expect(manifest.restoration).toBeDefined();
  expect(manifest.restoration?.trigger).toBe(trigger);
  expect(manifest.restoration?.pre_agent).toMatch(/^sha256:/);
  expect(manifest.restoration?.restored).toBe(manifest.restoration?.pre_agent);
}

describe('dirty-workspace restoration', () => {
  it('restores after an agent timeout', async () => {
    const { report, manifest } = await run(stubEnv({ STUB_MODE: 'hang' }));

    expect(report.status).toBe('failed');
    expect(report.category).toBe('agent_timeout');
    expectRestored(manifest, 'agent_timeout');
  }, 300_000);

  it('restores after a non-zero agent exit', async () => {
    const { report, manifest } = await run(stubEnv({ STUB_MODE: 'fail' }));

    expect(report.status).toBe('failed');
    expect(report.category).toBe('agent_failed');
    expectRestored(manifest, 'agent_failed');
  }, 300_000);

  it('restores after malformed agent events', async () => {
    const { report, manifest } = await run(
      stubEnv({ STUB_MODE: 'malformed', STUB_EVENTS: 'this is not json' }),
    );

    expect(report.status).toBe('failed');
    expectRestored(manifest, report.category ?? '');
  }, 300_000);

  it('restores after an error thrown between the agent and the diff', async () => {
    const { report, manifest } = await run(stubEnv(), {
      onPhase: (phase: RunPhase) => {
        if (phase === 'diff') throw new Error('injected post-agent failure');
      },
    });

    expect(report.status).toBe('failed');
    expect(report.failedPhase).toBe('diff');
    expectRestored(manifest, report.category ?? '');
  }, 300_000);

  it.each([
    ['out of scope', { STUB_WRITE_PATH: 'elsewhere/other.js' }],
    ['a dependency manifest', { STUB_WRITE_PATH: 'package.json' }],
  ])('restores after a change %s', async (_label, overrides) => {
    const { report, manifest } = await run(stubEnv(overrides));

    expect(report.status).toBe('failed');
    expect(report.failedPhase).toBe('diff');
    expect(report.category).toBe('invalid_change');
    expectRestored(manifest, 'invalid_change');
  }, 300_000);

  it('restores after an unsafe symlink', async () => {
    const { report, manifest } = await run(
      stubEnv({ STUB_SYMLINK_PATH: 'src/escape.js', STUB_SYMLINK_TARGET: '../../etc/passwd' }),
    );

    expect(report.status).toBe('failed');
    expect(report.category).toBe('invalid_change');
    expectRestored(manifest, 'invalid_change');
  }, 300_000);

  it('restores after the agent made no changes at all', async () => {
    const { report, manifest } = await run({
      STUB_MODE: 'events',
      STUB_EVENTS: cannedEvents(),
    });

    expect(report.status).toBe('failed');
    expect(report.category).toBe('invalid_change');
    expectRestored(manifest, 'invalid_change');
  }, 300_000);

  it('records the evidence in the failure manifest, not only in the success one', async () => {
    const { manifest } = await run(stubEnv({ STUB_MODE: 'fail' }));

    // A failure manifest that lost the run's identity would make the evidence unusable.
    expect(manifest.repository?.base_commit).toBe(repo.commit);
    expect(manifest.runtime?.agent_image_digest).toBe(stub.digest);
    expect(manifest.inputs?.task_hash).toMatch(/^sha256:/);
    expect(manifest.snapshots?.pre_agent).toBe(manifest.restoration?.pre_agent);
  }, 300_000);

  it('reports a restoration failure alongside, never instead of, the phase failure', async () => {
    const { report, manifest } = await run(stubEnv({ STUB_MODE: 'fail' }), {
      injection: {
        agent: stub,
        agentEnv: stubEnv({ STUB_MODE: 'fail' }),
        restoreWorkspace: () => Promise.reject(new Error('injected restore failure')),
      },
    });

    expect(report.status).toBe('failed');
    // The agent failure is what the run is about; the restore failure is additional.
    expect(report.failedPhase).toBe('agent');
    expect(report.category).toBe('agent_failed');
    expect(report.message).toContain('injected restore failure');
    expect(manifest.restoration).toBeUndefined();
  }, 300_000);
});

describe('verifier failure leaves the agent workspace alone', () => {
  it('does not restore, because only the disposable copy was touched', async () => {
    const { report, manifest } = await run(stubEnv({ STUB_WRITE_CONTENT: WRONG_SLUGIFY }));

    expect(report.status).toBe('failed');
    expect(report.failedPhase).toBe('verify');
    expect(report.category).toBe('verification_failed');

    // Verification mutates only its own copy, so there is nothing to undo.
    expect(manifest.restoration).toBeUndefined();

    // The implementation snapshot is still the acceptance candidate that was verified.
    expect(manifest.snapshots?.implementation).toMatch(/^sha256:/);
    expect(manifest.snapshots?.implementation).not.toBe(manifest.snapshots?.pre_agent);
  }, 300_000);

  it('leaves no verifier volumes behind', async () => {
    const { report } = await run(stubEnv({ STUB_WRITE_CONTENT: WRONG_SLUGIFY }));

    const { stdout } = await execa('docker', [
      'volume',
      'ls',
      '-q',
      '--filter',
      `label=ai-harness.attempt=${report.attempt}`,
    ]);

    expect(stdout.split('\n').filter((line) => line !== '')).toEqual([]);
  }, 300_000);
});
