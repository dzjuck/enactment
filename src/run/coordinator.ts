import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { execa } from 'execa';

import { ArtifactStore } from '../artifacts/store.js';
import { idempotencyKey } from '../git/idempotency.js';
import type { ApprovedInputs } from '../plan/execution-manifest.js';
import type { PlanRecord, PlanState, StateStore } from '../state/store.js';
import { newAttemptId } from '../volume/naming.js';
import {
  verifyPlanHead,
  type FinalVerificationOptions,
  type FinalVerificationResult,
} from '../verify/final.js';
import type { RunInjection } from './inject.js';
import { runStep, type RunReport, type StepExecutionOptions } from './orchestrator.js';
import { reconcile } from './recovery.js';

export interface CoordinatorOptions {
  approved: ApprovedInputs;
  store: StateStore;
  /** Artifact root; the coordinator owns the `<plan-id>/` tree beneath it. */
  artifactsRoot: string;
  /** Copied into the plan tree as approval evidence, when the CLI supplies it. */
  manifestPath?: string;
  sourceCodexHome?: string;
  storeDirectory?: string;
  dependencyCacheDirectory?: string;
  injection?: RunInjection;
  signal?: AbortSignal;
}

export interface CoordinatorDependencies {
  execute?: (options: StepExecutionOptions) => Promise<RunReport>;
  verifyFinal?: (options: FinalVerificationOptions) => Promise<FinalVerificationResult>;
}

export interface PlanStepReport {
  id: string;
  status: 'pending' | 'completed';
  attempt?: string;
  commit?: string;
}

export interface PlanFailure {
  step?: string;
  phase?: string;
  category?: string;
  message: string;
}

export interface PlanReport {
  plan: string;
  state: PlanState;
  branch: string;
  baseCommit: string;
  head?: string;
  steps: PlanStepReport[];
  finalVerification?: FinalVerificationResult;
  failure?: PlanFailure;
  cleanupErrors?: string[];
}

async function refExists(repoPath: string, branch: string): Promise<boolean> {
  const { exitCode } = await execa(
    'git',
    ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    { reject: false },
  );
  return exitCode === 0;
}

/**
 * Claim the next free `<prefix>-<n>` directory, creating it.
 *
 * Creating it is what makes the claim real: an executor that dies before writing anything
 * would otherwise leave the ordinal unused, and the next recovery run would write over the
 * evidence of the one before it.
 *
 * `run-<n>` under an attempt counts recovery runs, `run-<n>` under `final/` counts final
 * verifications and `invocation-<n>` counts coordinator invocations. They are read from the
 * directory they belong to, because three unrelated counters sharing one variable is how an
 * implementation writes evidence into the wrong place.
 */
async function claimOrdinalDirectory(dir: string, prefix: string): Promise<string> {
  const claimed = join(dir, `${prefix}-${String(await nextOrdinal(dir, prefix))}`);
  await mkdir(claimed, { recursive: true });
  return claimed;
}

async function nextOrdinal(dir: string, prefix: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 1;
  }

  const pattern = new RegExp(`^${prefix}-(\\d+)`);
  const used = entries.flatMap((name) => {
    const found = pattern.exec(name)?.[1];
    return found === undefined ? [] : [Number(found)];
  });

  return used.length === 0 ? 1 : Math.max(...used) + 1;
}

/**
 * Drive an approved plan to completion: one step at a time, in order, without asking again.
 *
 * Thin by design. The state store owns progress, the executor owns a step, the final verifier
 * owns the finished branch; this decides what runs next and records the outcome. It stops at
 * the first failure — there is no model retry loop and no plan repair here.
 */
export async function runPlan(
  options: CoordinatorOptions,
  dependencies: CoordinatorDependencies = {},
): Promise<PlanReport> {
  const execute = dependencies.execute ?? runStep;
  const verifyFinal = dependencies.verifyFinal ?? verifyPlanHead;

  const { approved, store } = options;
  const branch = `ai-harness/${approved.plan.id}`;
  const planRoot = join(options.artifactsRoot, approved.plan.id);
  const snapshots = new ArtifactStore(join(planRoot, 'snapshots'));

  const plan = store.registerPlan({
    planId: approved.plan.id,
    manifestHash: approved.manifestHash,
    planHash: approved.planHash,
    repoPath: approved.repoPath,
    branch,
    baseCommit: approved.baseCommit,
    stepIds: approved.plan.steps.map((step) => step.id),
  });

  // A finished plan is a no-op: its stored report is the answer, and rerunning it would spend
  // model tokens reproducing a result that is already recorded.
  if (plan.state === 'completed') {
    const stored = await latestReport(planRoot);
    if (stored !== undefined) return stored;
  }

  await mkdir(planRoot, { recursive: true });
  await copyFile(approved.planFile, join(planRoot, 'plan.yml'));
  if (options.manifestPath !== undefined) {
    await copyFile(options.manifestPath, join(planRoot, 'execution-manifest.yml'));
  }

  const state = (): PlanRecord => store.planByRow(plan.row) as PlanRecord;

  const finish = async (extra: Partial<PlanReport> = {}): Promise<PlanReport> => {
    const current = state();

    const value: PlanReport = {
      plan: current.planId,
      state: current.state,
      branch: current.branch,
      baseCommit: current.baseCommit,
      head: current.headCommit,
      steps: store.steps(plan.row).map((row) => ({
        id: row.stepId,
        status: row.status,
        attempt: store.attempts(row.row).at(-1)?.attemptId,
        commit: row.commit,
      })),
      ...extra,
    };

    await writeReport(planRoot, value);
    return value;
  };

  // Startup reconciliation: finish an interrupted acceptance and prove Git and SQLite still
  // agree, before anything is selected to run. A disagreement stops the plan without changing
  // either side.
  try {
    await reconcile(approved, store, plan, snapshots);
  } catch (error) {
    store.setPlanState(plan.row, 'failed');
    return await finish({
      failure: { message: error instanceof Error ? error.message : String(error) },
    });
  }

  // Crash leftovers: blobs no live row references. A `running` row here belongs to a dead
  // process, so its snapshots are leftovers too — the step reruns from its stored parent and
  // takes fresh ones.
  await pruneSnapshots(store, plan.row, snapshots, { atStartup: true });

  // After reconciliation, not before: an interrupted acceptance legitimately leaves a commit
  // on the branch that the database has not recorded yet, and checking first would report
  // the plan's own work as somebody else's ref. Step 4's acceptance guard catches the same
  // collision, but only once a whole agent run has been paid for; this one costs nothing.
  if (state().headCommit === undefined && (await refExists(approved.repoPath, branch))) {
    store.setPlanState(plan.row, 'failed');
    return await finish({
      failure: {
        message: `${branch} already exists but this plan has accepted nothing; the harness never adopts a ref it did not create`,
      },
    });
  }

  store.setPlanState(plan.row, 'running');

  for (;;) {
    const pending = store.nextPendingStep(plan.row);
    if (pending === undefined) break;

    const current = state();
    // Always from persisted accepted state, never from the user's checked-out HEAD: the
    // repository they are working in has nothing to do with where this plan is.
    const parentCommit = current.headCommit ?? current.baseCommit;
    const branchExists = current.headCommit !== undefined;

    const step = approved.plan.steps[pending.position];
    if (step === undefined) {
      throw new Error(`plan has no step at position ${String(pending.position)}`);
    }

    // A `running` row is an attempt whose process died: reuse its id so the whole step reruns
    // under one identity, and give the rerun its own `run-<n>` directory rather than writing
    // over the evidence the killed run left. A `failed` row is a recorded outcome and is never
    // reused — an explicit retry is a new attempt.
    const crashed = store.attempts(pending.row).find((entry) => entry.state === 'running');

    const attemptId = crashed?.attemptId ?? options.injection?.attempt ?? newAttemptId();
    const attemptRoot = join(planRoot, 'steps', pending.stepId, attemptId);
    const artifactDir = await claimOrdinalDirectory(attemptRoot, 'run');
    const key = idempotencyKey({
      manifestHash: approved.manifestHash,
      planId: approved.plan.id,
      stepId: pending.stepId,
      attempt: attemptId,
      parentCommit,
    });

    const attempt =
      crashed ??
      store.startAttempt({
        stepRow: pending.row,
        attemptId,
        parentCommit,
        artifactPath: artifactDir,
      });

    // Persisted before execution, so a second crash allocates `run-3` rather than reusing 2.
    if (crashed !== undefined) store.recordRecoveryRun(attempt.row, artifactDir);

    const outcome = await execute({
      step,
      planId: approved.plan.id,
      planHash: approved.planHash,
      manifestHash: approved.manifestHash,
      images: approved.images,
      repoPath: approved.repoPath,
      baseBranch: approved.baseBranch,
      parentCommit,
      branch,
      branchExists,
      attempt: attemptId,
      idempotencyKey: key,
      artifactDir,
      snapshots,
      sourceCodexHome: options.sourceCodexHome,
      storeDirectory: options.storeDirectory,
      dependencyCacheDirectory: options.dependencyCacheDirectory,
      injection: options.injection,
      signal: options.signal,
      onEvent: (event) => {
        if (event.kind === 'phase') store.setAttemptPhase(attempt.row, event.phase);
        if (event.kind === 'candidate') store.setAttemptCandidate(attempt.row, event.snapshot, key);
        if (event.kind === 'accepting') store.setAttemptState(attempt.row, 'accepting');
      },
    });

    if (outcome.status !== 'succeeded' || outcome.commit === undefined) {
      store.failAttempt(
        attempt.row,
        `${outcome.category ?? 'internal_error'}: ${outcome.message ?? 'step failed'}`,
      );
      store.setPlanState(plan.row, 'failed');
      await pruneSnapshots(store, plan.row, snapshots);

      return await finish({
        failure: {
          step: pending.stepId,
          phase: outcome.failedPhase,
          category: outcome.category,
          message: outcome.message ?? 'step failed',
        },
        ...(outcome.cleanupErrors === undefined ? {} : { cleanupErrors: outcome.cleanupErrors }),
      });
    }

    // Attempt, step and head in one transaction, finished before the next step is selected.
    store.completeAcceptance({
      planRow: plan.row,
      stepRow: pending.row,
      attemptRow: attempt.row,
      commit: outcome.commit,
    });
    await pruneSnapshots(store, plan.row, snapshots);
  }

  const head = state().headCommit;
  if (head === undefined) throw new Error('every step completed but no plan head was recorded');

  const finalRoot = join(planRoot, 'final');
  const finalVerification = await verifyFinal({
    repoPath: approved.repoPath,
    head,
    commands: approved.plan.final_verification.commands,
    artifactDir: await claimOrdinalDirectory(finalRoot, 'run'),
    snapshots,
    images: approved.images,
    dependencyCacheDirectory: options.dependencyCacheDirectory,
    signal: options.signal,
  });

  store.setPlanState(plan.row, finalVerification.status === 'pass' ? 'completed' : 'failed');
  await pruneSnapshots(store, plan.row, snapshots);

  return await finish({
    finalVerification,
    ...(finalVerification.status === 'pass'
      ? {}
      : { failure: { message: `final verification ${finalVerification.status}` } }),
  });
}

/**
 * Bounded retention (DESIGN.md §11), applied at attempt termination rather than continuously.
 *
 * A running attempt's snapshots stay: the verifier reads those tars during baseline, RED and
 * GREEN, so pruning mid-attempt would delete what the next phase needs. What survives a
 * termination is exactly the acceptance candidate of an attempt still in `accepting`, because
 * that is the one blob recovery needs to finish a commit without new model output. The hashes
 * remain in the attempt evidence either way.
 */
export async function pruneSnapshots(
  store: StateStore,
  planRow: number,
  snapshots: ArtifactStore,
  options: { atStartup?: boolean } = {},
): Promise<void> {
  const keep = new Set<string>();

  for (const step of store.steps(planRow)) {
    for (const attempt of store.attempts(step.row)) {
      // Mid-run, a `running` attempt is live and still reading its own tars. At startup the
      // same row means a process that died, and its blobs are leftovers.
      if (attempt.state === 'running' && options.atStartup !== true) return;
      if (attempt.state === 'accepting' && attempt.candidateSnapshot !== undefined) {
        keep.add(attempt.candidateSnapshot);
      }
    }
  }

  for (const artifact of await snapshots.list()) {
    if (!keep.has(artifact.hash)) await snapshots.remove(artifact);
  }
}

async function writeReport(planRoot: string, report: PlanReport): Promise<void> {
  const reports = join(planRoot, 'reports');
  await mkdir(reports, { recursive: true });

  const ordinal = await nextOrdinal(reports, 'invocation');
  await writeFile(
    join(reports, `invocation-${String(ordinal)}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

async function latestReport(planRoot: string): Promise<PlanReport | undefined> {
  const reports = join(planRoot, 'reports');
  const ordinal = (await nextOrdinal(reports, 'invocation')) - 1;
  if (ordinal < 1) return undefined;

  return JSON.parse(
    await readFile(join(reports, `invocation-${String(ordinal)}.json`), 'utf8'),
  ) as PlanReport;
}
