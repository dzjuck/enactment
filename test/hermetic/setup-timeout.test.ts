import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IMAGE_ROLES } from '../../src/config/pins.js';
import { DependencyCache, ensureDependencySnapshot } from '../../src/deps/setup.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { PhaseFailure } from '../../src/run/failure.js';

/**
 * A Docker daemon that never lets the install finish on its own, so the ladder — not the
 * install — is what ends the phase. `docker run` settles only once SIGKILL lands, which is
 * how a real container behaves once the harness stops asking politely.
 */
const { calls, fakeExeca, state } = vi.hoisted(() => {
  const recorded: string[][] = [];
  const shared = { termAt: 0, killAt: 0 };
  let endRun: ((result: unknown) => void) | undefined;

  const fake = (
    _file: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: Buffer | string; stderr: Buffer | string }> => {
    recorded.push(args);

    if (args[0] === 'volume' && args[1] === 'inspect') {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
    }

    if (args[0] === 'kill' && args.includes('TERM')) {
      shared.termAt = Date.now();
      // Deliberately ignored: the container keeps running, so the grace wait is exercised.
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    if (args[0] === 'kill' && args.includes('KILL')) {
      shared.killAt = Date.now();
      endRun?.({ exitCode: 137, stdout: Buffer.alloc(0), stderr: Buffer.from('killed') });
      endRun = undefined;
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    // The install container: hangs until it is killed.
    if (args[0] === 'run' && args.includes('hang-forever')) {
      return new Promise((resolve) => {
        endRun = resolve as (result: unknown) => void;
      });
    }

    return Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  };

  return { calls: recorded, fakeExeca: fake, state: shared };
});

vi.mock('execa', () => ({ execa: fakeExeca }));

const IMAGES = Object.fromEntries(
  IMAGE_ROLES.map((role, index) => [
    role,
    {
      role,
      reference: `sha256:${String(index + 1).repeat(64)}`,
      digest: `sha256:${String(index + 5).repeat(64)}`,
    },
  ]),
) as RuntimeImages;

const GRACE_SECONDS = 1;

let dir: string;

beforeEach(async () => {
  calls.length = 0;
  state.termAt = 0;
  state.killAt = 0;
  dir = await mkdtemp(join(tmpdir(), 'harness-setup-timeout-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function hangingInstall(cache: DependencyCache): Promise<unknown> {
  return ensureDependencySnapshot({
    cache,
    key: 'sha256:hanging-install',
    attempt: 'attempt-1',
    workspaceTar: Buffer.from('tar'),
    installCommand: ['hang-forever'],
    network: 'ai-harness-net-attempt-1-registry',
    images: IMAGES,
    setupSeconds: 0.05,
    graceSeconds: GRACE_SECONDS,
  });
}

describe('setup phase timeout', () => {
  it('escalates SIGTERM, waits the grace period, then SIGKILLs the install', async () => {
    const cache = new DependencyCache(join(dir, 'deps'));

    await expect(hangingInstall(cache)).rejects.toThrow(PhaseFailure);

    const signals = calls
      .filter((args) => args[0] === 'kill')
      .map((args) => args[args.indexOf('--signal') + 1]);

    expect(signals).toEqual(['TERM', 'KILL']);
    expect(state.killAt - state.termAt).toBeGreaterThanOrEqual(GRACE_SECONDS * 1000 - 50);
  });

  it('classifies the failure as setup_timeout, not setup_failed', async () => {
    const cache = new DependencyCache(join(dir, 'deps'));

    const failure = await hangingInstall(cache).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(PhaseFailure);
    expect((failure as PhaseFailure).category).toBe('setup_timeout');
    expect((failure as PhaseFailure).phase).toBe('setup');
  });

  it('publishes no cache entry for the timed-out key', async () => {
    const cache = new DependencyCache(join(dir, 'deps'));

    await expect(hangingInstall(cache)).rejects.toThrow(PhaseFailure);

    await expect(cache.has('sha256:hanging-install')).resolves.toBe(false);
  });

  it('removes the attempt workspace volume it created for the install', async () => {
    const cache = new DependencyCache(join(dir, 'deps'));

    await expect(hangingInstall(cache)).rejects.toThrow(PhaseFailure);

    const created = calls.find((args) => args[0] === 'volume' && args[1] === 'create');
    const removed = calls.find((args) => args[0] === 'volume' && args[1] === 'rm');

    expect(created?.at(-1)).toBeDefined();
    expect(removed?.at(-1)).toBe(created?.at(-1));
  });
});
