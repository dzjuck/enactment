import { execa } from 'execa';

import type { ArtifactStore } from '../artifacts/store.js';
import { sourceDiff } from '../diff/source-diff.js';
import { acceptChanges, TRAILERS } from '../git/accept.js';
import { exportCommit } from '../git/export.js';
import { findCommitByKey } from '../git/idempotency.js';
import type { ApprovedInputs } from '../plan/execution-manifest.js';
import type { AttemptRecord, PlanRecord, StateStore, StepRecord } from '../state/store.js';

export class ReconcileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconcileError';
  }
}

async function git(repoPath: string, args: string[]): Promise<string | undefined> {
  const { stdout, exitCode } = await execa('git', ['-C', repoPath, ...args], { reject: false });
  return exitCode === 0 ? stdout.trim() : undefined;
}

/**
 * Finish an attempt that was interrupted between its commit and the database write.
 *
 * Two shapes, told apart by whether the plan branch already carries the attempt's key:
 *
 *   - the commit exists — the process died after Git and before SQLite, so only the database
 *     transition is missing. It is completed here, with no agent and no verifier;
 *   - the commit does not exist — the candidate was verified but never committed, so Git
 *     acceptance is retried from the persisted snapshot under the same idempotency key.
 *
 * Either way the recorded parent, the step trailer and the branch position must agree with
 * what the database says. A disagreement fails closed: the harness does not repair a ref it
 * no longer recognises, and an unexplained commit is not evidence that a step succeeded.
 */
async function finishAcceptance(
  approved: ApprovedInputs,
  store: StateStore,
  plan: PlanRecord,
  step: StepRecord,
  attempt: AttemptRecord,
  snapshots: ArtifactStore,
): Promise<void> {
  const { repoPath } = approved;
  const key = attempt.idempotencyKey;

  if (key === undefined) {
    throw new ReconcileError(
      `attempt ${attempt.attemptId} of step "${step.stepId}" is "accepting" with no idempotency key`,
    );
  }

  const existing = (await refExists(repoPath, plan.branch))
    ? await findCommitByKey(repoPath, plan.branch, TRAILERS.idempotencyKey, key)
    : undefined;

  if (existing !== undefined) {
    const message = (await git(repoPath, ['log', '-1', '--format=%B', existing])) ?? '';
    if (!message.includes(`${TRAILERS.step}: ${step.stepId}`)) {
      throw new ReconcileError(
        `commit ${existing} carries attempt ${attempt.attemptId}'s key but not step "${step.stepId}"`,
      );
    }

    const parent = await git(repoPath, ['rev-parse', `${existing}^`]);
    if (parent !== attempt.parentCommit) {
      throw new ReconcileError(
        `commit ${existing} carries attempt ${attempt.attemptId}'s key but its parent is ${String(parent)}, not the recorded ${attempt.parentCommit}`,
      );
    }

    const tip = await git(repoPath, ['rev-parse', `refs/heads/${plan.branch}`]);
    if (tip !== existing) {
      throw new ReconcileError(
        `${plan.branch} is at ${String(tip)}, but attempt ${attempt.attemptId} committed ${existing}`,
      );
    }

    store.completeAcceptance({
      planRow: plan.row,
      stepRow: step.row,
      attemptRow: attempt.row,
      commit: existing,
    });
    return;
  }

  if (attempt.candidateSnapshot === undefined) {
    throw new ReconcileError(
      `attempt ${attempt.attemptId} of step "${step.stepId}" is "accepting" with no verified candidate to accept`,
    );
  }

  // Only Git acceptance is retried. The candidate was verified before the attempt entered
  // `accepting`, so finishing it needs no model output and no second verification.
  const { tar } = await exportCommit(repoPath, attempt.parentCommit);
  const candidate = await snapshots.read(attempt.candidateSnapshot);
  const changes = await sourceDiff(tar, candidate);

  const accepted = await acceptChanges({
    repoPath,
    parentCommit: attempt.parentCommit,
    branchExists: plan.headCommit !== undefined,
    branch: plan.branch,
    planId: plan.planId,
    stepId: step.stepId,
    attempt: attempt.attemptId,
    idempotencyKey: key,
    verificationStatus: 'pass',
    changes,
  });

  store.completeAcceptance({
    planRow: plan.row,
    stepRow: step.row,
    attemptRow: attempt.row,
    commit: accepted.commit,
  });
}

async function refExists(repoPath: string, branch: string): Promise<boolean> {
  return (await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) !==
    undefined;
}

/**
 * Reconcile SQLite with Git before any work is selected.
 *
 * Runs after the global resource sweep the production CLI performs, and before the first step
 * of this invocation. It finishes what an interrupted acceptance left half-done and refuses to
 * continue when the branch and the database disagree about where the plan is.
 *
 * A `running` attempt is deliberately left alone: the whole step reruns from its stored
 * parent, keeping its attempt id, which the coordinator handles when it selects work.
 */
export async function reconcile(
  approved: ApprovedInputs,
  store: StateStore,
  plan: PlanRecord,
  snapshots: ArtifactStore,
): Promise<void> {
  for (const step of store.steps(plan.row)) {
    for (const attempt of store.attempts(step.row)) {
      if (attempt.state !== 'accepting') continue;
      await finishAcceptance(approved, store, store.planByRow(plan.row) as PlanRecord, step, attempt, snapshots);
    }
  }

  // Only now, with interrupted acceptances resolved: before that the branch is legitimately
  // one commit ahead of the recorded head.
  const current = store.planByRow(plan.row) as PlanRecord;
  const tip = await git(approved.repoPath, ['rev-parse', `refs/heads/${current.branch}`]);

  if (current.headCommit !== undefined && tip !== current.headCommit) {
    throw new ReconcileError(
      `${current.branch} is at ${tip ?? 'no commit'}, but this plan recorded head ${current.headCommit}; refusing to move a ref the harness no longer recognises`,
    );
  }
}
