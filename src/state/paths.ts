import { homedir } from 'node:os';
import { join } from 'node:path';

/** Harness state — credentials, caches, the plan database — lives outside artifacts. */
export function stateDirectory(): string {
  return process.env.HARNESS_STATE_DIR ?? join(homedir(), '.local', 'state', 'ai-harness');
}

export function databasePath(): string {
  return join(stateDirectory(), 'state.db');
}
