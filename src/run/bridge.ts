import { join } from 'node:path';

import { execa } from 'execa';

import { ArtifactStore } from '../artifacts/store.js';
import { resolveRuntimeImages, type RuntimeImages } from '../docker/images.js';
import {
  bundleRootFor,
  contextDirFor,
  DocumentationError,
  verifyBundle,
  type ApprovedDocumentation,
} from '../docs/bundle.js';
import { idempotencyKey } from '../git/idempotency.js';
import { loadPlan } from '../plan/load.js';
import type { Plan, PlanStep } from '../plan/schema.js';
import { resolveNormalProfile } from '../routing/profiles.js';
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
 * Take the only step of a one-step plan.
 *
 * A multi-step plan is refused rather than truncated: running step 1 and reporting success
 * would claim the whole plan was executed.
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

/** What a caller supplies. Everything the executor needs is derived from it here. */
export interface RunOptions {
  planFile: string;
  repoPath: string;
  artifactDir: string;
  sourceCodexHome?: string;
  claudeTokenFile?: string;
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
 * Resolve a one-step plan into executor inputs and run it.
 *
 * Test-only scaffolding, and not reachable from the CLI: production runs the coordinator,
 * which takes these same values from the approved manifest rather than reading the plan and
 * the repository head itself. It survives because the M1 and M2 pipeline suites exercise one
 * step against a real daemon, and driving that through a whole plan would test the
 * coordinator instead of the executor.
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
    // No approved manifest on this path, so the bundle beside the plan is verified here
    // instead. Production takes the same directory from `validateManifest`. A declared bundle
    // that is not there stops the run: an agent that silently gets no `/context` is a step
    // running against different inputs than the plan describes.
    let documentation: ApprovedDocumentation | undefined;
    if (plan.documentation !== undefined) {
      const bundleRoot = bundleRootFor(options.planFile);
      const bundle = await verifyBundle(bundleRoot, plan.documentation);
      if (!bundle.present) {
        throw new DocumentationError(
          'bundle_missing',
          `${options.planFile} declares documentation but ${bundleRoot} does not exist; run "harness docs ${options.planFile}" first`,
        );
      }
      documentation = { contextDir: contextDirFor(bundleRoot), hash: bundle.hash };
    }
    const parentCommit = await git(options.repoPath, ['rev-parse', 'HEAD']);
    const baseBranch = await git(options.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    // One immutable image set for the whole run: every container is started from it, and the
    // manifest records this same value rather than a separately resolved one.
    const images = await (dependencies.resolveImages ?? (() => resolveRuntimeImages()))();

    inputs = {
      step,
      profile: resolveNormalProfile(step.complexity),
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
      documentation,
      sourceCodexHome: options.sourceCodexHome,
      claudeTokenFile: options.claudeTokenFile,
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
