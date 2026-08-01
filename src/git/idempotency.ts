import { createHash } from 'node:crypto';

import { execa } from 'execa';

export interface IdempotencyInputs {
  taskId: string;
  taskHash: string;
  baseCommit: string;
  attempt: string;
}

/**
 * Keys an accepted commit to its inputs, so a re-run after a crash recovers the existing
 * commit rather than producing a second one (§31's recovery property, available in M1 for
 * free because the key lives in a trailer).
 */
export function idempotencyKey(inputs: IdempotencyInputs): string {
  const canonical = JSON.stringify({
    taskId: inputs.taskId,
    taskHash: inputs.taskHash,
    baseCommit: inputs.baseCommit,
    attempt: inputs.attempt,
  });

  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export async function findCommitByKey(
  repoPath: string,
  trailer: string,
  key: string,
): Promise<string | undefined> {
  const { stdout, exitCode } = await execa(
    'git',
    [
      '-C',
      repoPath,
      'log',
      '--all',
      '--format=%H',
      '--fixed-strings',
      `--grep=${trailer}: ${key}`,
      '--max-count=1',
    ],
    { reject: false },
  );

  if (exitCode !== 0) return undefined;
  const found = stdout.trim();
  return found === '' ? undefined : found;
}
