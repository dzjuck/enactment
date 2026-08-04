import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { stateDirectory } from '../state/paths.js';

export class ClaudeTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeTokenError';
  }
}

export function claudeTokenPath(root: string = stateDirectory()): string {
  return join(root, 'auth', 'claude', 'token');
}

function mode(value: number): string {
  return `0${(value & 0o777).toString(8)}`;
}

export async function loadClaudeToken(path: string = claudeTokenPath()): Promise<string> {
  const directory = dirname(path);

  let directoryStat;
  try {
    directoryStat = await stat(directory);
  } catch {
    throw new ClaudeTokenError(
      `Claude token file ${path} is missing; run \`claude setup-token\`, then write it there with directory mode 0700 and file mode 0600`,
    );
  }
  if ((directoryStat.mode & 0o777) !== 0o700) {
    throw new ClaudeTokenError(
      `Claude token directory ${directory} has mode ${mode(directoryStat.mode)}; require 0700`,
    );
  }

  let fileStat;
  let token: string;
  try {
    [fileStat, token] = await Promise.all([stat(path), readFile(path, 'utf8')]);
  } catch {
    throw new ClaudeTokenError(
      `Claude token file ${path} is missing; run \`claude setup-token\`, then write it there with mode 0600`,
    );
  }
  if ((fileStat.mode & 0o777) !== 0o600) {
    throw new ClaudeTokenError(`Claude token file ${path} has mode ${mode(fileStat.mode)}; require 0600`);
  }

  const value = token.trim();
  if (value === '') {
    throw new ClaudeTokenError(
      `Claude token file ${path} is blank; run \`claude setup-token\` and replace it`,
    );
  }
  return value;
}

export function claudeTokenSecrets(token: string): string[] {
  return [token];
}
