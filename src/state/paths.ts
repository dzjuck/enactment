import { homedir } from 'node:os';
import { join } from 'node:path';

/** Harness state — credentials, caches, the plan database — lives outside artifacts. */
export function stateDirectory(): string {
  return process.env.ENACTMENT_STATE_DIR ?? join(homedir(), '.local', 'state', 'enactment');
}
