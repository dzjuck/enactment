import { join } from 'node:path';

import { execa } from 'execa';

import { ArtifactStore } from '../artifacts/store.js';
import { resolveRuntimeImages, type RuntimeImages } from '../docker/images.js';
import { idempotencyKey } from '../git/idempotency.js';
import { loadPlan } from '../plan/load.js';
import type { Plan, PlanStep } from '../plan/schema.js';
import { newAttemptId } from '../volume/naming.js';
import type { RunInjection } from './inject.js';
import {
  runStep,
  type OnStepEvent,
  type RunPhase,
  type RunReport,
  type StepExecutionOptions,
} from './orchestrator.js';

export { RUN_PHASES } from './orchestrator.js';
export type { OnStepEvent, RunPhase, RunReport, StepEvent } from './orchestrator.js';

/**
 * Temporary bridge from a plan to the single-step executor.
 *
 * The executor runs one step per invocation; the plan coordinator that walks a whole plan
 * arrives in Step 7. Until then a multi-step plan is refused rather than truncated: a harness
 * that silently ran step 1 and reported success would claim the plan was executed.
 */
export function singlePlanStep(plan: Plan): PlanStep {
  const [step] = plan.steps;

  if (step === undefined || plan.steps.length !== 1) {
    throw new Error(
      `plan "${plan.id}" declares ${String(plan.steps.length)} steps; this harness build runs exactly one`,
    );
  }

  return step;
}

/** What the CLI supplies. Everything the executor needs is derived from it here. */
export interface RunOptions {
  planFile: string;
  repoPath: string;
  artifactDir: string;
  sourceCodexHome?: string;
  storeDirectory?: string;
  dependencyCacheDirectory?: string;
  /** Test-only substitution of runtime images and agent environment. See `RunInjection`. */
  injection?: RunInjection;
  onPhase?: (phase: RunPhase) => void | Promise<void>;
  onEvent?: OnStepEvent;
  signal?: AbortSignal;
}

export interface BridgeDependencies {
  resolveImages?: () => Promise<RuntimeImages>;
  execute?: (options: StepExecutionOptions) => Promise<RunReport>;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', ['-C', repoPath, ...args]);
  return stdout;
}

/**
 * Resolve a one-step plan into approved executor inputs and run it.
 *
 * This is where the plan is read, the images are resolved and the repository head is looked
 * up — once, before anything starts. The coordinator replaces it in Step 7 and takes those
 * values from the approved manifest instead; the executor below it does not change.
 */
export async function runSinglePlanStep(
  options: RunOptions,
  dependencies: BridgeDependencies = {},
): Promise<RunReport> {
  const execute = dependencies.execute ?? runStep;
  const attempt = options.injection?.attempt ?? newAttemptId();

  let inputs: StepExecutionOptions;
  try {
    const { plan, hash: planHash } = await loadPlan(options.planFile);
    const step = singlePlanStep(plan);
    const parentCommit = await git(options.repoPath, ['rev-parse', 'HEAD']);
    const baseBranch = await git(options.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    // One immutable image set for the whole run: every container is started from it, and the
    // manifest records this same value rather than a separately resolved one.
    const images = await (dependencies.resolveImages ?? (() => resolveRuntimeImages()))();

    inputs = {
      step,
      planId: plan.id,
      planHash,
      // No approved manifest exists on this path, so the plan's own byte hash is the
      // approval identity. The coordinator supplies the manifest hash instead.
      manifestHash: planHash,
      images,
      repoPath: options.repoPath,
      baseBranch,
      parentCommit,
      branch: `ai-harness/${plan.id}`,
      // Always a plan's first acceptance here: one step, so there is no earlier head.
      branchExists: false,
      attempt,
      idempotencyKey: idempotencyKey({
        manifestHash: planHash,
        planId: plan.id,
        stepId: step.id,
        attempt,
        parentCommit,
      }),
      artifactDir: options.artifactDir,
      snapshots: new ArtifactStore(join(options.artifactDir, 'snapshots')),
      sourceCodexHome: options.sourceCodexHome,
      storeDirectory: options.storeDirectory,
      dependencyCacheDirectory: options.dependencyCacheDirectory,
      injection: options.injection,
      onPhase: options.onPhase,
      onEvent: options.onEvent,
      signal: options.signal,
    };
  } catch (error) {
    // Nothing has started yet, so this is a report rather than a throw: the CLI prints one
    // shape for every outcome.
    return {
      status: 'failed',
      attempt,
      failedPhase: 'export',
      category: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return await execute(inputs);
}
