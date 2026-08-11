import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportCommit } from '../../src/git/export.js';
import { DependencyCache, ensureDependencySnapshot, SetupError } from '../../src/deps/setup.js';
import { withPhaseNetworks } from '../../src/net/manage.js';
import { PhaseFailure } from '../../src/run/failure.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { runtimeImages } from '../helpers/images.js';
import { createRepo, createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { readArchive } from '../../src/artifacts/archive.js';
import type { RuntimeImages } from '../../src/docker/images.js';

const REGISTRY_NETWORK = 'bridge';
const NPM_CI = ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];

let repo: TargetRepo;
let lifecycle: TargetRepo;
let tar: Buffer;
let lifecycleTar: Buffer;
let cache: DependencyCache;
let cacheRoot: string;
let images: RuntimeImages;
const coldKey = 'sha256:cold';

beforeAll(async () => {
  images = await runtimeImages();
  repo = await createTargetRepo();
  ({ tar } = await exportCommit(repo.dir, repo.commit));

  lifecycle = await createRepo('lifecycle-repo');
  ({ tar: lifecycleTar } = await exportCommit(lifecycle.dir, lifecycle.commit));

  cacheRoot = await mkdtemp(join(tmpdir(), 'enactment-deps-'));
  cache = new DependencyCache(cacheRoot);
}, 120_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await removeRepo(lifecycle.dir);
  await rm(cacheRoot, { recursive: true, force: true });
});

describe('dependency setup', () => {
  it('runs the install on a cold key and snapshots node_modules', async () => {
    const result = await ensureDependencySnapshot({
      cache,
      key: coldKey,
      attempt: newAttemptId(),
      workspaceTar: tar,
      installCommand: NPM_CI,
      network: REGISTRY_NETWORK,
      images,
    });

    expect(result.cached).toBe(false);

    const entries = (await readArchive(await cache.read(coldKey))).map((entry) => entry.path);
    expect(entries.some((path) => path.startsWith('node_modules/vitest'))).toBe(true);
  }, 600_000);

  it('does not re-run the install on a warm key', async () => {
    // A sentinel the install would necessarily overwrite. Timing would prove nothing.
    const sentinel = Buffer.from('SENTINEL-NOT-A-REAL-SNAPSHOT');
    await cache.put(coldKey, sentinel);

    const result = await ensureDependencySnapshot({
      cache,
      key: coldKey,
      attempt: newAttemptId(),
      workspaceTar: tar,
      installCommand: NPM_CI,
      network: REGISTRY_NETWORK,
      images,
    });

    expect(result.cached).toBe(true);
    expect(await cache.read(coldKey)).toEqual(sentinel);
  });

  it('skips lifecycle scripts when the policy denies them', async () => {
    const denied = await ensureDependencySnapshot({
      cache,
      key: 'sha256:lifecycle-denied',
      attempt: newAttemptId(),
      workspaceTar: lifecycleTar,
      installCommand: ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
      network: 'none',
      images,
    });

    expect(denied.output).not.toContain('POSTINSTALL_RAN');
  }, 120_000);

  it('control: the same package runs its postinstall when scripts are allowed', async () => {
    const allowed = await ensureDependencySnapshot({
      cache,
      key: 'sha256:lifecycle-allowed',
      attempt: newAttemptId(),
      workspaceTar: lifecycleTar,
      installCommand: ['npm', 'install', '--no-audit', '--no-fund'],
      network: 'none',
      images,
    });

    expect(allowed.output).toContain('POSTINSTALL_RAN');
  }, 120_000);

  it('attaches one network only, with no provider auth mount or variable', async () => {
    const probe = await ensureDependencySnapshot({
      cache,
      key: 'sha256:probe',
      attempt: newAttemptId(),
      workspaceTar: lifecycleTar,
      installCommand: [
        'sh',
        '-c',
        [
          'echo NETS=$(ls /sys/class/net | sort | tr "\\n" ",")',
          'echo AUTH=$(test -e /run/agent-auth && echo yes || echo no)',
          'echo AUTHENV=$(env | grep -icE "codex|openai|api_key" || true)',
        ].join('; '),
      ],
      network: REGISTRY_NETWORK,
      images,
    });

    expect(probe.output).toContain('NETS=eth0,lo,');
    expect(probe.output).toContain('AUTH=no');
    expect(probe.output).toContain('AUTHENV=0');
  }, 120_000);

  it('writes no cache entry when the install fails', async () => {
    const key = 'sha256:failing-install';

    await expect(
      ensureDependencySnapshot({
        cache,
        key,
        attempt: newAttemptId(),
        workspaceTar: tar,
        // `--offline` against an empty cache fails the same way, but in a second rather than
        // after npm's ~70s registry retry ladder.
        installCommand: [...NPM_CI, '--offline'],
        network: 'none',
        images,
      }),
    ).rejects.toThrow(SetupError);

    await expect(cache.has(key)).resolves.toBe(false);
  }, 120_000);
});

describe('setup phase budget', () => {
  /** Every attempt-scoped resource carries this, so a leak is a count rather than a guess. */
  const LABEL = 'enactment.attempt';

  async function labelled(attempt: string, kind: 'container' | 'volume' | 'network'): Promise<string[]> {
    const filter = `label=${LABEL}=${attempt}`;
    const args =
      kind === 'container' ? ['ps', '-aq', '--filter', filter] : [kind, 'ls', '-q', '--filter', filter];

    const { stdout } = await execa('docker', args);
    return stdout.split('\n').filter((line) => line !== '');
  }

  /** An install that never exits: the ladder, not the command, has to end the phase. */
  function hangingInstall(attempt: string): Promise<unknown> {
    return withPhaseNetworks(attempt, 'setup', (networks) =>
      ensureDependencySnapshot({
        cache,
        key: 'sha256:hanging-install',
        attempt,
        workspaceTar: tar,
        installCommand: ['sh', '-c', 'while true; do sleep 1; done'],
        network: networks.registry ?? 'none',
        images,
        setupSeconds: 2,
        graceSeconds: 1,
      }),
    );
  }

  it('stops a hanging install within its budget and classifies it setup_timeout', async () => {
    const started = Date.now();

    const failure = await hangingInstall(newAttemptId()).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(PhaseFailure);
    expect((failure as PhaseFailure).category).toBe('setup_timeout');
    // The budget is 2s plus the grace; anything near the 600s default means it was ignored.
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 120_000);

  it('leaves no cache entry for the timed-out key', async () => {
    await expect(hangingInstall(newAttemptId())).rejects.toThrow(PhaseFailure);

    await expect(cache.has('sha256:hanging-install')).resolves.toBe(false);
  }, 120_000);

  it('leaves no setup container, workspace volume or registry network behind', async () => {
    const attempt = newAttemptId();

    await expect(hangingInstall(attempt)).rejects.toThrow(PhaseFailure);

    await expect(labelled(attempt, 'container')).resolves.toEqual([]);
    await expect(labelled(attempt, 'volume')).resolves.toEqual([]);
    await expect(labelled(attempt, 'network')).resolves.toEqual([]);
  }, 120_000);
});
