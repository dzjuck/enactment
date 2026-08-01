import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTH_FILE,
  AuthError,
  copyBackAuth,
  prepareRunAuth,
  seedAuthStore,
} from '../../src/auth/store.js';
import { collectSecrets, createRedactor } from '../../src/artifacts/redact.js';

const CANARY = 'sk-canary-9f3ab27c0d1e4a6b8c5d';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `harness-${prefix}-`));
  dirs.push(dir);
  return dir;
}

function authJson(token: string): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: `id-${token}`,
      access_token: `access-${token}`,
      refresh_token: `refresh-${token}`,
      account_id: 'acct_123',
    },
    last_refresh: '2026-08-01T00:00:00Z',
  });
}

async function sourceHome(token = CANARY): Promise<string> {
  const dir = await tempDir('codex-source');
  await writeFile(join(dir, AUTH_FILE), authJson(token));
  return dir;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('auth store', () => {
  it('seeds an absent store from the source Codex home', async () => {
    const source = await sourceHome();
    const store = await seedAuthStore(await tempDir('store'), source);

    expect(await readFile(store.file, 'utf8')).toBe(authJson(CANARY));
  });

  it('never overwrites an established store from the source', async () => {
    const storeDir = await tempDir('store');
    await seedAuthStore(storeDir, await sourceHome('first'));

    // The store owns the refresh chain once established; a stale source must not clobber it.
    const store = await seedAuthStore(storeDir, await sourceHome('second'));

    expect(await readFile(store.file, 'utf8')).toBe(authJson('first'));
  });

  it('takes rotated credentials back from the run home', async () => {
    const store = await seedAuthStore(await tempDir('store'), await sourceHome('before'));
    const runHome = await tempDir('run-home');
    await prepareRunAuth(store, runHome);

    await writeFile(join(runHome, AUTH_FILE), authJson('rotated'));
    const changed = await copyBackAuth(runHome, store);

    expect(changed).toBe(true);
    expect(await readFile(store.file, 'utf8')).toBe(authJson('rotated'));
  });

  it('never writes to the user real Codex home', async () => {
    const source = await sourceHome();
    await chmod(source, 0o500);

    const store = await seedAuthStore(await tempDir('store'), source);
    const runHome = await tempDir('run-home');
    await prepareRunAuth(store, runHome);
    await writeFile(join(runHome, AUTH_FILE), authJson('rotated'));

    await expect(copyBackAuth(runHome, store)).resolves.toBe(true);
    expect(await readFile(join(source, AUTH_FILE), 'utf8')).toBe(authJson(CANARY));
    expect(await readdir(source)).toEqual([AUTH_FILE]);
  });

  it('keeps stored and run credentials at mode 0600', async () => {
    const store = await seedAuthStore(await tempDir('store'), await sourceHome());
    const runHome = await tempDir('run-home');
    await prepareRunAuth(store, runHome);

    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(runHome, AUTH_FILE))).mode & 0o777).toBe(0o600);
  });

  it('names codex login when the source has no auth.json', async () => {
    const empty = await tempDir('codex-empty');

    await expect(seedAuthStore(await tempDir('store'), empty)).rejects.toThrow(AuthError);
    await expect(seedAuthStore(await tempDir('store'), empty)).rejects.toThrow(/codex login/);
  });

  it('lets no token value reach an artifact, a log line, an error, or the manifest', async () => {
    const source = await sourceHome();
    const store = await seedAuthStore(await tempDir('store'), source);

    const secrets = collectSecrets(await readFile(store.file, 'utf8'));
    expect(secrets).toContain(`access-${CANARY}`);
    expect(secrets).toContain(`refresh-${CANARY}`);

    const redact = createRedactor(secrets);
    const artifacts = await tempDir('artifacts');
    await mkdir(join(artifacts, 'logs'), { recursive: true });

    await writeFile(
      join(artifacts, 'logs/agent.log'),
      redact(`authorization: Bearer access-${CANARY}\nrefreshed with refresh-${CANARY}\n`),
    );
    await writeFile(
      join(artifacts, 'run-manifest.json'),
      redact(JSON.stringify({ note: `token id-${CANARY} was used` })),
    );
    await writeFile(
      join(artifacts, 'error.txt'),
      redact(`request failed for access-${CANARY}`),
    );

    for (const file of await walk(artifacts)) {
      expect(await readFile(file, 'utf8')).not.toContain(CANARY);
    }
  });

  it('keeps token values out of its own error messages', async () => {
    const source = await tempDir('codex-source');
    await writeFile(join(source, AUTH_FILE), `not json ${CANARY}`);

    let error: unknown;
    try {
      await seedAuthStore(await tempDir('store'), source);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(AuthError);
    expect((error as Error).message).not.toContain(CANARY);
  });
});
