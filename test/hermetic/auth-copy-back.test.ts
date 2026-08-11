import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectSecrets, createRedactor } from '../../src/artifacts/redact.js';
import { AUTH_FILE, AuthError, seedAuthStore, type AuthStore } from '../../src/auth/store.js';
import { copyBackAuth, readAuthVolumeFile } from '../../src/auth/volume.js';
import { IMAGE_ROLES } from '../../src/config/pins.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { withCleanupOutcome } from '../../src/run/cleanup.js';
import type { RunReport } from '../../src/run/orchestrator.js';

const CANARY = 'sk-copyback-canary-8d21f4';
const STORED = JSON.stringify({ tokens: { access_token: CANARY, refresh_token: `r-${CANARY}` } });

/**
 * The auth reader is the only part of this suite that touches Docker, and it is mocked: the
 * question here is what the harness does with the helper's *result*, not whether a container
 * runs. `readerExit` is what the next reader invocation reports.
 */
const { reader, fakeExeca } = vi.hoisted(() => {
  const state = { exitCode: 0, stdout: '', stderr: '' };

  const fake = (): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> =>
    Promise.resolve({
      exitCode: state.exitCode,
      stdout: Buffer.from(state.stdout),
      stderr: Buffer.from(state.stderr),
    });

  return { reader: state, fakeExeca: fake };
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

const dirs: string[] = [];

afterEach(async () => {
  Object.assign(reader, { exitCode: 0, stdout: '', stderr: '' });
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh store per test: copy-back rewrites it, so sharing one leaks state between them. */
async function store(): Promise<AuthStore> {
  const root = await mkdtemp(join(tmpdir(), 'enactment-copyback-'));
  dirs.push(root);
  await writeFile(join(root, AUTH_FILE), STORED);

  return seedAuthStore(join(root, 'store'), root);
}

/** The volume is irrelevant where reading it is the injected step. */
const VOLUME = 'enactment-auth-a1';

describe('the auth reader', () => {
  it('turns a non-zero helper exit into an AuthError, not an absent file', async () => {
    Object.assign(reader, { exitCode: 1, stderr: `cat: ${AUTH_FILE}: Permission denied` });

    const error = await readAuthVolumeFile(VOLUME, AUTH_FILE, IMAGES).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(AuthError);
    expect((error as Error).message).toContain(VOLUME);
    expect((error as Error).message).toContain(AUTH_FILE);
  });

  it('returns the credential bytes when the helper succeeds', async () => {
    Object.assign(reader, { exitCode: 0, stdout: `${STORED}\n` });

    await expect(readAuthVolumeFile(VOLUME, AUTH_FILE, IMAGES)).resolves.toBe(`${STORED}\n`);
  });
});

describe('auth copy-back', () => {
  it('leaves the established store byte-identical when nothing rotated', async () => {
    const established = await store();
    const before = await readFile(established.file, 'utf8');

    // The agent read its credential and wrote it back unchanged, which is the common case.
    const changed = await copyBackAuth(VOLUME, established, IMAGES, {
      read: () => Promise.resolve(before),
    });

    expect(changed).toBe(false);
    expect(await readFile(established.file, 'utf8')).toBe(before);
  });

  it('records a rotation exactly, including a trailing newline', async () => {
    const established = await store();
    const rotated = `${JSON.stringify({ tokens: { access_token: `${CANARY}-new` } })}\n`;

    await expect(
      copyBackAuth(VOLUME, established, IMAGES, { read: () => Promise.resolve(rotated) }),
    ).resolves.toBe(true);

    expect(await readFile(established.file, 'utf8')).toBe(rotated);
    // Atomic: the staging file is renamed, never left beside the credential it replaced.
    expect(await readdir(established.directory)).toEqual([AUTH_FILE]);
    expect((await stat(established.file)).mode & 0o777).toBe(0o600);
  });

  it('fails when the run credential is missing, rather than reporting nothing to do', async () => {
    const established = await store();
    const before = await readFile(established.file, 'utf8');

    const error = await copyBackAuth(VOLUME, established, IMAGES, {
      read: () => Promise.reject(new AuthError(`reading ${AUTH_FILE} from ${VOLUME} failed (1)`)),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AuthError);
    expect(await readFile(established.file, 'utf8')).toBe(before);
  });

  it('refuses invalid JSON and never renames it over the established store', async () => {
    const established = await store();
    const before = await readFile(established.file, 'utf8');

    const error = await copyBackAuth(VOLUME, established, IMAGES, {
      read: () => Promise.resolve('{"tokens": truncated'),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AuthError);
    // The message names the file, never its content.
    expect((error as Error).message).toContain(AUTH_FILE);
    expect((error as Error).message).not.toContain('truncated');

    expect(await readFile(established.file, 'utf8')).toBe(before);
    expect(await readdir(established.directory)).toEqual([AUTH_FILE]);
  });

  it('refuses an empty credential, which is a wiped file rather than a rotation', async () => {
    const established = await store();
    const before = await readFile(established.file, 'utf8');

    await expect(
      copyBackAuth(VOLUME, established, IMAGES, { read: () => Promise.resolve('') }),
    ).rejects.toBeInstanceOf(AuthError);

    expect(await readFile(established.file, 'utf8')).toBe(before);
  });
});

const SUCCEEDED: RunReport = { status: 'succeeded', attempt: 'a1', commit: '0'.repeat(40) };
const FAILED: RunReport = {
  status: 'failed',
  attempt: 'a1',
  failedPhase: 'agent',
  category: 'agent_timeout',
  message: 'agent run timeout (exit -1)',
};

describe('a copy-back failure is never silent', () => {
  it('prevents an otherwise successful run from reporting success', () => {
    const report = withCleanupOutcome(SUCCEEDED, ['auth copy-back failed: store unwritable']);

    expect(report.status).toBe('failed');
    expect(report.cleanupErrors?.[0]).toContain('copy-back');
  });

  it('keeps the verified commit visible on the failed report', () => {
    const report = withCleanupOutcome(SUCCEEDED, ['auth copy-back failed: store unwritable']);

    // Both facts matter: the work was verified and committed, and the credential was lost.
    expect(report.commit).toBe(SUCCEEDED.commit);
  });

  it('preserves the primary phase failure and records copy-back beside it', () => {
    const report = withCleanupOutcome(FAILED, ['auth copy-back failed: store unwritable']);

    expect(report.failedPhase).toBe('agent');
    expect(report.category).toBe('agent_timeout');
    expect(report.message).toBe(FAILED.message);
    expect(report.cleanupErrors).toEqual(['auth copy-back failed: store unwritable']);
  });

  it('records the cleanup error without any credential value in it', () => {
    const redact = createRedactor(collectSecrets(STORED));
    const leaky = `auth copy-back failed while writing ${CANARY}`;

    const report = withCleanupOutcome(FAILED, [redact(leaky)]);

    expect(report.cleanupErrors?.[0]).not.toContain(CANARY);
    expect(report.cleanupErrors?.[0]).toContain('[redacted]');
  });
});
