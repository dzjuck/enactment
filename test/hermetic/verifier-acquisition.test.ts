import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactStore, type StoredArtifact } from '../../src/artifacts/store.js';
import { IMAGE_ROLES } from '../../src/config/pins.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { CleanupError } from '../../src/run/cleanup.js';
import { OwnershipError } from '../../src/run/ownership.js';
import { runVerification } from '../../src/verify/run.js';

const { calls, fakeExeca } = vi.hoisted(() => {
  const recorded: string[][] = [];

  const fake = (
    _file: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: Buffer | string; stderr: Buffer | string }> => {
    recorded.push(args);

    if (args[0] === 'volume' && args[1] === 'inspect') {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
    }

    return Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  };

  return { calls: recorded, fakeExeca: fake };
});

vi.mock('execa', () => ({ execa: fakeExeca }));

const IMAGES = Object.fromEntries(
  IMAGE_ROLES.map((role, index) => [
    role,
    {
      role,
      id: `sha256:${String(index + 1).repeat(64)}`,
    },
  ]),
) as RuntimeImages;

let dir: string;
let snapshot: StoredArtifact;

beforeEach(async () => {
  calls.length = 0;
  dir = await mkdtemp(join(tmpdir(), 'harness-verifier-acq-'));
  snapshot = await new ArtifactStore(join(dir, 'artifacts')).put(Buffer.from('snapshot'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function verify(overrides: Partial<Parameters<typeof runVerification>[0]> = {}) {
  return runVerification({
    attempt: 'attempt-1',
    snapshot,
    dependencySnapshot: Buffer.alloc(0),
    commands: [['npx', 'vitest', 'run']],
    artifactDir: join(dir, 'artifacts'),
    images: IMAGES,
    ...overrides,
  });
}

describe('verifier acquisition rollback', () => {
  it('releases the workspace volume when the dependency volume cannot be created', async () => {
    const removed: string[] = [];

    const failure = await verify({
      createDependencies: () => Promise.reject(new Error('dependency volume unavailable')),
      removeVolume: async (name) => void removed.push(name),
    }).catch((cause: unknown) => cause);

    expect((failure as Error).message).toContain('dependency volume unavailable');

    // The workspace volume existed before the failure, so it has to be released — and the
    // dependency volume was never acquired, so it must not be referenced during cleanup.
    expect(removed).toEqual(['ai-harness-ws-attempt-1-verify']);
  });

  it('releases both volumes when restore fails after acquiring them', async () => {
    const removed: string[] = [];

    const failure = await verify({
      restore: () => Promise.reject(new Error('snapshot does not match its content hash')),
      removeVolume: async (name) => void removed.push(name),
    }).catch((cause: unknown) => cause);

    expect((failure as Error).message).toContain('snapshot does not match');
    expect(removed).toEqual([
      'ai-harness-deps-attempt-1-verify-verifier',
      'ai-harness-ws-attempt-1-verify',
    ]);
  });

  it('retains the acquisition error when the rollback itself fails', async () => {
    const failure = await verify({
      createDependencies: () => Promise.reject(new Error('dependency volume unavailable')),
      removeVolume: () => Promise.reject(new Error('volume removal refused')),
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(OwnershipError);
    expect(((failure as OwnershipError).cause as Error).message).toContain(
      'dependency volume unavailable',
    );
    expect((failure as OwnershipError).cleanupCause).toBeInstanceOf(CleanupError);
    expect((failure as Error).message).toContain('volume removal refused');
  });

  it('reports a rollback failure even when acquisition succeeded', async () => {
    const failure = await verify({
      removeVolume: () => Promise.reject(new Error('volume removal refused')),
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(CleanupError);
    expect((failure as CleanupError).errors.join('\n')).toContain('volume removal refused');
  });

  it('releases both volumes on the ordinary path', async () => {
    const removed: string[] = [];

    const result = await verify({ removeVolume: async (name) => void removed.push(name) });

    expect(result.status).toBe('pass');
    expect(removed).toEqual([
      'ai-harness-deps-attempt-1-verify-verifier',
      'ai-harness-ws-attempt-1-verify',
    ]);
  });
});
