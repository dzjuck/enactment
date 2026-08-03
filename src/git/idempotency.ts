import { createHash } from 'node:crypto';

import { execa } from 'execa';

export interface IdempotencyInputs {
  /** Identity of the approved execution manifest. */
  manifestHash: string;
  planId: string;
  stepId: string;
  /** The stable attempt id; a crashed attempt keeps it, an explicit retry gets a new one. */
  attempt: string;
  /** The commit this step's work is built on. */
  parentCommit: string;
}

/**
 * Keys an accepted commit to the exact work that produced it.
 *
 * The key is stable across processes, which is what makes recovery possible: a run that
 * crashed after committing but before recording it finds its own commit by this key instead
 * of making a second one. Every element is load-bearing — the parent because the same step
 * retried from a different head is different work, and the attempt because an explicit retry
 * after a recorded failure is a new attempt and gets its own commit.
 */
export function idempotencyKey(inputs: IdempotencyInputs): string {
  const canonical = JSON.stringify({
    manifestHash: inputs.manifestHash,
    planId: inputs.planId,
    stepId: inputs.stepId,
    attempt: inputs.attempt,
    parentCommit: inputs.parentCommit,
  });

  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Find a commit carrying `key`, searching only the plan branch.
 *
 * Scoped to the branch rather than `--all` on purpose: a commit with a matching trailer that
 * the plan branch cannot reach is not the plan's accepted work — it is a leftover from a
 * deleted branch, or something a user copied — and treating it as accepted would report a
 * commit the branch does not contain.
 */
export async function findCommitByKey(
  repoPath: string,
  branch: string,
  trailer: string,
  key: string,
): Promise<string | undefined> {
  const { stdout, exitCode } = await execa(
    'git',
    [
      '-C',
      repoPath,
      'log',
      branch,
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
