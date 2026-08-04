import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import type { RuntimeImage } from '../../src/docker/images.js';
import { runSinglePlanStep, type RunPhase, type RunReport } from '../../src/run/bridge.js';
import { authVolumeName } from '../../src/volume/naming.js';
import { volumeExists } from '../../src/volume/workspace.js';
import {
  createTargetRepo,
  removePlanBranches,
  removeRepo,
  type TargetRepo,
} from '../helpers/repo.js';
import { planDocument } from '../helpers/plan.js';
import { cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

const SLUGIFY = `export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

const SEEDED = JSON.stringify({ tokens: { access_token: 'sk-seeded', refresh_token: 'r-seeded' } });

/** What the agent leaves behind after the provider rotates its refresh token. */
const ROTATED = `${JSON.stringify({
  tokens: { access_token: 'sk-rotated', refresh_token: 'r-rotated' },
  last_refresh: '2026-08-02T12:00:00Z',
})}\n`;

let repo: TargetRepo;
let root: string;
let planFile: string;
let stub: RuntimeImage;
let stores = 0;
const dirs: string[] = [];

beforeAll(async () => {
  stub = await stubAgentImage();
  repo = await createTargetRepo();
  root = await mkdtemp(join(tmpdir(), 'harness-copyback-'));

  const source = join(root, 'codex-source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, AUTH_FILE), SEEDED);

  planFile = join(root, 'plan.yml');
  await writeFile(
    planFile,
    planDocument([
        'type: task',
        'complexity: low',
        'id: add-slugify',
        'observable_behavior: Implement the slugify function in src/slugify.js',
        'implementation_paths:',
        '  - src/slugify.js',
        'verification:',
        '  commands:',
        '    - ["npx", "--no-install", "vitest", "run", "--config", "vitest.config.js"]',
        'timeouts:',
        '  connectivity_smoke_seconds: 20',
        '  agent_seconds: 15',
        '  termination_grace_seconds: 2',
    ]),
  );
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await removePlanBranches(repo.dir);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Outcome {
  report: RunReport;
  artifacts: string;
  stored: string;
  storeFile: string;
  manifest: { result: { cleanup_errors?: string[] } };
}

/**
 * Run a step whose agent rotates its credential and then meets `mode`'s fate.
 *
 * Each run gets its own store, seeded from the same source: the store is what copy-back
 * rewrites, so a shared one would carry a previous test's rotation.
 */
async function runRotating(
  env: Record<string, string>,
  overrides: Partial<Parameters<typeof runSinglePlanStep>[0]> = {},
): Promise<Outcome> {
  const artifacts = await mkdtemp(join(tmpdir(), 'harness-artifacts-'));
  dirs.push(artifacts);

  stores += 1;
  const storeDirectory = join(root, `store-${String(stores)}`);

  const report = await runSinglePlanStep({
    planFile,
    repoPath: repo.dir,
    artifactDir: artifacts,
    sourceCodexHome: join(root, 'codex-source'),
    storeDirectory,
    dependencyCacheDirectory: join(root, 'deps'),
    ...overrides,
    injection: {
      codex: stub,
      agentEnv: {
        STUB_EVENTS: cannedEvents(),
        STUB_WRITE_PATH: 'src/slugify.js',
        STUB_WRITE_CONTENT: SLUGIFY,
        STUB_AUTH_CONTENT: ROTATED,
        ...env,
      },
      ...overrides.injection,
    },
  });

  return {
    report,
    artifacts,
    stored: await readFile(join(storeDirectory, AUTH_FILE), 'utf8'),
    storeFile: join(storeDirectory, AUTH_FILE),
    manifest: JSON.parse(await readFile(join(artifacts, 'run-manifest.json'), 'utf8')) as {
      result: { cleanup_errors?: string[] };
    },
  };
}

describe('a rotated credential survives every way the agent block can end', () => {
  it('survives a successful run', async () => {
    const { report, stored } = await runRotating({ STUB_MODE: 'write' });

    expect(report.status).toBe('succeeded');
    expect(stored).toBe(ROTATED);
  }, 300_000);

  it('survives an EventParseError', async () => {
    const { report, stored } = await runRotating({
      STUB_MODE: 'malformed',
      STUB_EVENTS: 'this is not json',
    });

    // The parse error is thrown from inside the adapter, past the point the old code copied
    // back — the rotated token went to the volume and the volume was then deleted.
    expect(report.status).toBe('failed');
    expect(stored).toBe(ROTATED);
  }, 300_000);

  it('survives an exception thrown after the agent exits', async () => {
    const { report, stored } = await runRotating(
      { STUB_MODE: 'write' },
      {
        onPhase: (phase: RunPhase) => {
          if (phase === 'diff') throw new Error('injected post-agent failure');
        },
      },
    );

    expect(report.status).toBe('failed');
    expect(stored).toBe(ROTATED);
  }, 300_000);

  it('survives an agent timeout', async () => {
    const { report, stored } = await runRotating({ STUB_MODE: 'hang' });

    expect(report.category).toBe('agent_timeout');
    expect(stored).toBe(ROTATED);
  }, 300_000);

  it('survives a non-zero agent exit', async () => {
    const { report, stored } = await runRotating({ STUB_MODE: 'fail' });

    expect(report.category).toBe('agent_failed');
    expect(stored).toBe(ROTATED);
  }, 300_000);

  it('copies back before the auth volume is deleted, and the volume is still deleted', async () => {
    const { report, stored } = await runRotating({ STUB_MODE: 'fail' });

    expect(stored).toBe(ROTATED);
    await expect(volumeExists(authVolumeName(report.attempt))).resolves.toBe(false);
  }, 300_000);

  it('leaves no credential value in the artifact tree', async () => {
    const { report, artifacts } = await runRotating({ STUB_MODE: 'fail' });
    expect(report.status).toBe('failed');

    const { stdout } = await execa('grep', ['-rl', 'r-rotated', artifacts], { reject: false });
    expect(stdout.trim()).toBe('');
  }, 300_000);
});

/**
 * A credential the harness cannot read or cannot parse is not a rotation, and treating it as
 * "nothing to copy back" would silently keep a token the provider has already replaced. The
 * run fails; the previously established store is what survives.
 */
describe('a run credential that cannot be trusted fails the run', () => {
  it.each([
    ['missing', { STUB_AUTH_FATE: 'remove' }],
    ['unreadable', { STUB_AUTH_FATE: 'unreadable' }],
    ['not valid JSON', { STUB_AUTH_CONTENT: '{"tokens": truncated' }],
  ])('fails the run when the run credential is %s', async (_name, env) => {
    const { report, stored, storeFile } = await runRotating({ STUB_MODE: 'write', ...env });

    expect(report.status).toBe('failed');
    expect(report.cleanupErrors?.join('; ')).toContain(AUTH_FILE);

    // The host store is left exactly as it was, and still usable by the next run.
    expect(stored).toBe(SEEDED);
    expect((await stat(storeFile)).mode & 0o777).toBe(0o600);
    await expect(volumeExists(authVolumeName(report.attempt))).resolves.toBe(false);
  }, 300_000);

  it('still reports the commit the run verified before copy-back failed', async () => {
    const { report } = await runRotating({ STUB_MODE: 'write', STUB_AUTH_FATE: 'remove' });

    // Both facts, on one report: the work was verified and committed, and the credential
    // could not be saved. Hiding either one sends the operator looking in the wrong place.
    expect(report.status).toBe('failed');
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);
  }, 300_000);

  it('writes no credential value into the failure it reports', async () => {
    const { report, artifacts } = await runRotating({
      STUB_MODE: 'write',
      STUB_AUTH_CONTENT: `{"tokens": {"refresh_token": "r-rotated"`,
    });

    expect(report.status).toBe('failed');

    const { stdout } = await execa('grep', ['-rl', 'r-rotated', artifacts], { reject: false });
    expect(stdout.trim()).toBe('');
  }, 300_000);
});
