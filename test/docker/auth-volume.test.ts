import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CODEX_HOME_PATH, compileCodexPolicy } from '../../src/adapters/codex/policy.js';
import { AUTH_FILE, AuthError, seedAuthStore, type AuthStore } from '../../src/auth/store.js';
import {
  authMount,
  copyBackAuth,
  createAuthVolume,
  readAuthVolumeFile,
} from '../../src/auth/volume.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { runContainer } from '../../src/docker/run.js';
import { authVolumeName, newAttemptId } from '../../src/volume/naming.js';
import { removeVolume, volumeExists } from '../../src/volume/workspace.js';
import { runtimeImages } from '../helpers/images.js';

const CANARY = 'sk-auth-volume-canary-3f7a91';
const STORED = JSON.stringify({ tokens: { access_token: CANARY, refresh_token: `r-${CANARY}` } });

const policy = compileCodexPolicy({ prompt: 'noop', workdir: '/workspace' });

let images: RuntimeImages;
let root: string;
let source: string;
const created: string[] = [];

beforeAll(async () => {
  images = await runtimeImages();
  root = await mkdtemp(join(tmpdir(), 'enactment-auth-vol-'));

  source = join(root, 'codex-source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, AUTH_FILE), STORED);
});

/** A store of its own per test: copy-back rewrites it, so sharing one leaks state. */
async function freshStore(): Promise<AuthStore> {
  return seedAuthStore(await mkdtemp(join(root, 'store-')), source);
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((name) => removeVolume(name)));
});

async function seeded(attempt = newAttemptId()): Promise<string> {
  const volume = await createAuthVolume(
    attempt,
    { provider: 'codex', auth: STORED, policy: policy.files },
    images,
  );
  created.push(volume);
  return volume;
}

/** Runs in the hardened agent container, exactly as the agent phase would. */
function inAgent(volume: string, argv: string[]) {
  return runContainer({
    image: images.codex.id,
    argv,
    network: 'none',
    mounts: [authMount('codex', volume)],
  });
}

describe('per-run auth volume', () => {
  it('is owned by numeric uid/gid 1001 and is private', async () => {
    const volume = await seeded();

    const result = await inAgent(volume, [
      'sh',
      '-c',
      `stat -c '%u %g %a' ${CODEX_HOME_PATH} ${CODEX_HOME_PATH}/${AUTH_FILE}`,
    ]);

    const [directory, file] = result.stdout.trim().split('\n');
    expect(directory).toBe('1001 1001 700');
    expect(file).toBe('1001 1001 600');
  }, 120_000);

  it('is readable and writable by the hardened agent', async () => {
    const volume = await seeded();

    const read = await inAgent(volume, ['cat', `${CODEX_HOME_PATH}/${AUTH_FILE}`]);
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain(CANARY);

    // Rotation rewrites the file in place; a read-only credential path breaks refresh.
    const write = await inAgent(volume, [
      'sh',
      '-c',
      `printf '%s' rotated > ${CODEX_HOME_PATH}/${AUTH_FILE}`,
    ]);
    expect(write.exitCode).toBe(0);
  }, 120_000);

  it('carries the compiled policy alongside the credential', async () => {
    const volume = await seeded();

    const result = await inAgent(volume, ['cat', `${CODEX_HOME_PATH}/config.toml`]);

    expect(result.stdout).toBe(policy.files['config.toml']);
  }, 120_000);

  it('copies a rotated credential back to the host store byte for byte', async () => {
    const store = await freshStore();
    const volume = await seeded();
    const rotated = `${JSON.stringify({
      tokens: { access_token: `${CANARY}-new`, refresh_token: `r-${CANARY}-new` },
      last_refresh: '2026-08-02T00:00:00Z',
    })}\n`;

    // Written the way Codex would write it: from inside the container, not from the host.
    const rewrite = await runContainer(
      {
        image: images.codex.id,
        argv: ['sh', '-c', `cat > ${CODEX_HOME_PATH}/${AUTH_FILE}`],
        network: 'none',
        mounts: [authMount('codex', volume)],
      },
      { input: Buffer.from(rotated) },
    );
    expect(rewrite.exitCode).toBe(0);

    await expect(copyBackAuth(volume, store, images)).resolves.toBe(true);
    expect(await readFile(store.file, 'utf8')).toBe(rotated);
  }, 120_000);

  it('reports no rotation when the credential is unchanged', async () => {
    const store = await freshStore();
    const volume = await seeded();

    await expect(copyBackAuth(volume, store, images)).resolves.toBe(false);
  }, 120_000);

  it('fails on a missing credential rather than reading it as absent', async () => {
    const volume = await seeded();

    await inAgent(volume, ['rm', `${CODEX_HOME_PATH}/${AUTH_FILE}`]);

    // "Absent" and "unreadable" are the same observation from here, and neither is a reason
    // to keep a token the provider may already have rotated away.
    await expect(readAuthVolumeFile(volume, AUTH_FILE, images)).rejects.toThrow(AuthError);
  }, 120_000);

  it('is attempt-scoped and swept by the attempt label', async () => {
    const attempt = newAttemptId();
    const volume = await seeded(attempt);

    expect(volume).toBe(authVolumeName('codex', attempt));

    const { stdout } = await execa('docker', [
      'volume',
      'ls',
      '-q',
      '--filter',
      `label=enactment.attempt=${attempt}`,
    ]);
    expect(stdout.split('\n')).toContain(volume);
  }, 120_000);

  it('leaves no volume behind when seeding fails', async () => {
    const attempt = newAttemptId();

    await expect(
      createAuthVolume(
        attempt,
        { provider: 'codex', auth: STORED, policy: policy.files },
        images,
        { seed: () => Promise.reject(new Error('injected seed failure')) },
      ),
    ).rejects.toThrow('injected seed failure');

    await expect(volumeExists(authVolumeName('codex', attempt))).resolves.toBe(false);
  }, 120_000);

  it('never binds the host auth directory into a container', async () => {
    const volume = await seeded();

    expect(authMount('codex', volume)).toEqual({
      type: 'volume',
      source: volume,
      target: CODEX_HOME_PATH,
    });
  }, 120_000);
});
