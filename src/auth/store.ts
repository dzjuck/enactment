import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CODEX_HOME_PATH } from '../adapters/codex/policy.js';
import type { Mount } from '../docker/args.js';

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

/** Copy the stored credentials into the per-run CODEX_HOME that will be mounted. */
export async function prepareRunAuth(store: AuthStore, runHomeDirectory: string): Promise<void> {
  await mkdir(runHomeDirectory, { recursive: true, mode: 0o700 });

  const stored = await readIfPresent(store.file);
  if (stored === undefined) {
    throw new AuthError(`auth store ${store.file} is missing; re-seed it before running`);
  }

  await writePrivate(join(runHomeDirectory, AUTH_FILE), stored);
}

/**
 * Take back whatever Codex left behind. A read-only mount would break refresh, and a
 * discarded rotation fails on some later run with no attributable cause.
 */
export async function copyBackAuth(
  runHomeDirectory: string,
  store: AuthStore,
): Promise<boolean> {
  const current = await readIfPresent(join(runHomeDirectory, AUTH_FILE));
  if (current === undefined) return false;

  const stored = await readIfPresent(store.file);
  if (stored === current) return false;

  await writePrivate(store.file, current);
  return true;
}

export function authMount(runHomeDirectory: string): Mount {
  // Read-write: the provider CLI persists rotated credentials here (§5).
  return { type: 'bind', source: runHomeDirectory, target: CODEX_HOME_PATH };
}

export function authEnv(): Record<string, string> {
  return { CODEX_HOME: CODEX_HOME_PATH };
}
