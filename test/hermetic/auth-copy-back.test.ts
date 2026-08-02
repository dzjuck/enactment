import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectSecrets, createRedactor } from '../../src/artifacts/redact.js';
import { AUTH_FILE, seedAuthStore, type AuthStore } from '../../src/auth/store.js';
import { copyBackAuth } from '../../src/auth/volume.js';
import { IMAGE_ROLES } from '../../src/config/pins.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { withCleanupOutcome } from '../../src/run/cleanup.js';
import type { RunReport } from '../../src/run/orchestrator.js';

const CANARY = 'sk-copyback-canary-8d21f4';
const STORED = JSON.stringify({ tokens: { access_token: CANARY, refresh_token: `r-${CANARY}` } });

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
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh store per test: copy-back rewrites it, so sharing one leaks state between them. */
async function store(): Promise<AuthStore> {
  const root = await mkdtemp(join(tmpdir(), 'harness-copyback-'));
  dirs.push(root);
  await writeFile(join(root, AUTH_FILE), STORED);

  return seedAuthStore(join(root, 'store'), root);
}

/** The volume is irrelevant here: reading it is the injected step. */
const VOLUME = 'ai-harness-auth-a1';

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
  });

  it('treats an absent credential as nothing to copy back', async () => {
    const established = await store();
    const before = await readFile(established.file, 'utf8');

    await expect(
      copyBackAuth(VOLUME, established, IMAGES, { read: () => Promise.resolve(undefined) }),
    ).resolves.toBe(false);

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
