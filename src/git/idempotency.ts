import { createHash } from 'node:crypto';

import { execa } from 'execa';

export interface IdempotencyInputs {
  taskId: string;
  taskHash: string;
  baseCommit: string;
  attempt: string;
}

/**
 * Keys an accepted commit to its inputs, so acceptance cannot produce two commits for one
 * attempt.
 *
 * The key is attempt-scoped on purpose, and that bounds what it can do. §31's recovery
 * property — a re-run picking up an accepted commit instead of making a second one — needs a
 * *stable* attempt id to key on, which means the persistent state Milestone 3 introduces. In
 * M1 every run mints a fresh attempt id, so a repeated run is a genuinely new attempt and gets
 * its own commit. Keying across runs would be worse than useless here anyway: nothing checks
 * the key until acceptance, so the model call would already have been paid for.
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
