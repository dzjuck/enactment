import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CODEX_HOME_PATH } from '../adapters/codex/policy.js';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export const AUTH_FILE = 'auth.json';

export interface AuthStore {
  directory: string;
  file: string;
}

export function defaultSourceCodexHome(): string {
  return join(homedir(), '.codex');
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * The harness keeps its own credential store, seeded once from the user's Codex home.
 *
 * Once established the store is the source of truth for the refresh chain: Codex rotates
 * `tokens.refresh_token` in place, so re-seeding from a stale source would hand back a spent
 * token. The user's real Codex home is read exactly once and never written.
 */
export async function seedAuthStore(
  storeDirectory: string,
  sourceCodexHome: string = defaultSourceCodexHome(),
): Promise<AuthStore> {
  await mkdir(storeDirectory, { recursive: true, mode: 0o700 });
  const store: AuthStore = {
    directory: storeDirectory,
    file: join(storeDirectory, AUTH_FILE),
  };

  const existing = await readIfPresent(store.file);
  if (existing !== undefined) return store;

  const sourceFile = join(sourceCodexHome, AUTH_FILE);
  const source = await readIfPresent(sourceFile);

  if (source === undefined) {
    throw new AuthError(
      `no ${AUTH_FILE} in ${sourceCodexHome}: run \`codex login\` once, then retry`,
    );
  }

  try {
    JSON.parse(source);
  } catch {
    // The message names the file, never its content.
    throw new AuthError(`${sourceFile} is not valid JSON; re-run \`codex login\``);
  }

  await writePrivate(store.file, source);
  return store;
}

/** The stored credential, for seeding a run's credential volume. */
export async function readAuthStore(store: AuthStore): Promise<string> {
  const stored = await readIfPresent(store.file);
  if (stored === undefined) {
    throw new AuthError(`auth store ${store.file} is missing; re-seed it before running`);
  }

  return stored;
}

/**
 * Record a rotated credential, replacing the stored one only when it actually changed.
 *
 * The write goes through a private temporary file and a rename, so a reader never observes a
 * half-written credential and an interrupted update cannot truncate the refresh chain.
 */
export async function updateAuthStore(store: AuthStore, content: string): Promise<boolean> {
  const stored = await readIfPresent(store.file);
  if (stored === content) return false;

  const staging = `${store.file}.staging`;
  await writePrivate(staging, content);
  await rename(staging, store.file);
  await chmod(store.file, 0o600);

  return true;
}

export function authEnv(): Record<string, string> {
  return { CODEX_HOME: CODEX_HOME_PATH };
}
