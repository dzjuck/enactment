import { createHash } from 'node:crypto';

import { execa } from 'execa';

/** DESIGN.md §14. Defined here rather than beside acceptance, because reading them back is
 * this module's job and acceptance imports it, not the other way round. */
export const TRAILERS = {
  plan: 'Enactment-Plan',
  step: 'Enactment-Step',
  attempt: 'Enactment-Attempt',
  idempotencyKey: 'Enactment-Idempotency-Key',
};

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
 * The values one trailer carries on one commit.
 *
 * A trailer read rather than a search of the message: prose that mentions the trailer text is
 * not a trailer, and a substring match would let `Enactment-Step: persist-runs` be satisfied
 * by a commit whose step is `persist-runs-index`. Like every read here it yields nothing when
 * git fails, which fails the caller's check closed.
 */
export async function trailerValues(
  repoPath: string,
  commit: string,
  trailer: string,
): Promise<string[]> {
  const { stdout, exitCode } = await execa(
    'git',
    ['-C', repoPath, 'log', '-1', `--format=%(trailers:key=${trailer},valueonly)`, commit],
    { reject: false },
  );

  if (exitCode !== 0) return [];
  return stdout
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

export interface AcceptedStep {
  stepId: string;
  /** The commit whose trailer carries it. */
  commit: string;
}

/**
 * Every step ID an `Enactment-Step` trailer carries, reachable from `commit`, newest first.
 *
 * This is what tells an operator that an amended plan still lists a step the base already
 * accepted (DESIGN.md §30). It reads trailers rather than commit messages, so prose that
 * merely mentions the trailer text is not a match, and it is scoped to one commit's ancestry,
 * so work on a sibling branch is not the base's history.
 *
 * A git failure yields nothing rather than throwing. The production caller has already proven
 * the commit exists in the repository, and the product is a warning: refusing to prepare a
 * manifest because an advisory scan could not run would be a worse failure than the one it
 * exists to prevent.
 */
export async function acceptedStepIds(
  repoPath: string,
  commit: string,
): Promise<AcceptedStep[]> {
  const { stdout, exitCode } = await execa(
    'git',
    [
      '-C',
      repoPath,
      'log',
      commit,
      `--format=%H%x09%(trailers:key=${TRAILERS.step},valueonly,separator=%x2C)`,
    ],
    { reject: false },
  );

  if (exitCode !== 0) return [];

  const accepted: AcceptedStep[] = [];
  for (const line of stdout.split('\n')) {
    const [sha, values] = line.split('\t');
    if (sha === undefined || values === undefined) continue;

    for (const stepId of values.split(',')) {
      const trimmed = stepId.trim();
      if (trimmed !== '') accepted.push({ stepId: trimmed, commit: sha });
    }
  }

  return accepted;
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
