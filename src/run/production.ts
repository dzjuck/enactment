import { join } from 'node:path';

import { ArtifactStore } from '../artifacts/store.js';
import type { RuntimeImages } from '../docker/images.js';
import { resolveRuntimeImages } from '../docker/images.js';
import {
  bundleRootFor,
  contextDirFor,
  documentationHash,
  readProvenance,
  verifyBundle,
  writeBundle,
} from '../docs/bundle.js';
import {
  runDocumentationDownload,
  type DocumentationDownloadOptions,
  type DocumentationDownloadResult,
} from '../docs/download.js';
import { loadPlan } from '../plan/load.js';
import {
  ApprovalError,
  buildManifest,
  loadManifest,
  validateManifest,
  writeManifest,
} from '../plan/execution-manifest.js';
import { stateDirectory } from '../state/paths.js';
import { StateStore } from '../state/store.js';
import { sweepHarness } from './cleanup.js';
import { runPlan, type CoordinatorOptions, type PlanReport } from './coordinator.js';
import type { CancelCommand, Command, DocsCommand, PrepareCommand, RunCommand } from './options.js';

export interface ProductionDependencies {
  sweep?: () => Promise<void>;
  resolveImages?: () => Promise<RuntimeImages>;
  coordinate?: (options: CoordinatorOptions) => Promise<PlanReport>;
  download?: (options: DocumentationDownloadOptions) => Promise<DocumentationDownloadResult>;
}

export interface CommandResult {
  /** Printed as JSON on stdout, whatever the outcome. */
  report: unknown;
  exitCode: number;
}

function databasePath(command: Command): string {
  return join(command.stateDirectory ?? stateDirectory(), 'state.db');
}

function failure(error: unknown): CommandResult {
  return {
    report: {
      ...(error instanceof ApprovalError ? { error: error.reason } : { error: 'failed' }),
      message: error instanceof Error ? error.message : String(error),
    },
    exitCode: 1,
  };
}

/**
 * Resolve a plan into a candidate manifest for the user to approve.
 *
 * Read-only apart from the manifest it writes: no sweep, no container, no plan state. Running
 * the manifest is the approval, so nothing here may leave a trace that looks like one.
 */
async function prepare(
  command: PrepareCommand,
  dependencies: ProductionDependencies,
): Promise<CommandResult> {
  const manifest = await buildManifest({
    planFile: command.planFile,
    manifestPath: command.output,
    repoPath: command.repoPath,
    ...(dependencies.resolveImages === undefined
      ? {}
      : { resolveImages: dependencies.resolveImages }),
  });

  await writeManifest(command.output, manifest);

  return { report: { prepared: command.output, ...manifest }, exitCode: 0 };
}

/**
 * The one approval action: clean up after a previous process, prove the approval still holds,
 * then run the plan.
 *
 * The order is the point. The sweep comes first because a V1 harness killed outright leaves
 * labelled containers, volumes and networks whose owning attempt id died with the process, and
 * startup is the only unambiguous moment to remove them — V1 does not support two production
 * runs at once, and this is where that assumption is cashed in. Validation comes next, so a
 * drifted approval stops before any plan state advances. Artifact allocation stays the
 * coordinator's, so evidence and progress cannot disagree about where a run wrote.
 */
async function run(
  command: RunCommand,
  dependencies: ProductionDependencies,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const coordinate = dependencies.coordinate ?? runPlan;

  await (dependencies.sweep ?? sweepHarness)();

  const loaded = await loadManifest(command.manifestPath);
  const approved = await validateManifest(loaded, {
    repoPath: command.repoPath,
    ...(dependencies.resolveImages === undefined
      ? {}
      : { resolveImages: dependencies.resolveImages }),
  });

  const store = StateStore.open(databasePath(command));

  try {
    const report = await coordinate({
      approved,
      store,
      artifactsRoot: command.artifactDir,
      manifestPath: command.manifestPath,
      ...(command.sourceCodexHome === undefined
        ? {}
        : { sourceCodexHome: command.sourceCodexHome }),
      ...(command.storeDirectory === undefined ? {} : { storeDirectory: command.storeDirectory }),
      ...(command.dependencyCacheDirectory === undefined
        ? {}
        : { dependencyCacheDirectory: command.dependencyCacheDirectory }),
      ...(signal === undefined ? {} : { signal }),
    });

    return { report, exitCode: report.state === 'completed' ? 0 : 1 };
  } finally {
    store.close();
  }
}

/**
 * Release a repository from the plan that owns it.
 *
 * The branch, its commits, the attempt history and the evidence all survive: they record work
 * that really happened, and cancelling a plan is not a reason to destroy it. The exception is
 * the snapshot store, which §11 bounds by attempt termination — a plan retired after a process
 * was killed mid-attempt still holds that attempt's workspace tars, and nothing would ever
 * come back for them. Retiring the plan is the last moment anything can.
 *
 * Idempotent, because an operator retrying a cancel should not have to know whether the first
 * one landed. A completed plan is a no-op for the same reason: it already owns nothing.
 */
async function cancel(command: CancelCommand): Promise<CommandResult> {
  const loaded = await loadManifest(command.manifestPath);
  const store = StateStore.open(databasePath(command));

  try {
    const plan = store.planForManifest(command.repoPath, loaded.manifestHash);

    if (plan === undefined) {
      return {
        report: {
          error: 'not_registered',
          message: `no plan from ${command.manifestPath} is registered against ${command.repoPath}`,
        },
        exitCode: 1,
      };
    }

    if (plan.state !== 'cancelled' && plan.state !== 'completed') {
      store.cancelPlan(command.repoPath, loaded.manifestHash);
    }

    // Everything, not only what an `accepting` attempt still needs: the plan is terminal, so
    // there is no acceptance left for a candidate to finish.
    const snapshots = new ArtifactStore(join(command.artifactDir, plan.planId, 'snapshots'));
    for (const artifact of await snapshots.list()) {
      await snapshots.remove(artifact);
    }

    return {
      report: {
        plan: plan.planId,
        state: plan.state === 'completed' ? 'completed' : 'cancelled',
        branch: plan.branch,
        head: plan.headCommit,
      },
      exitCode: 0,
    };
  } finally {
    store.close();
  }
}

/**
 * Produce the documentation bundle a plan declares, or report the one that is already there.
 *
 * Idempotent and all-or-nothing: a complete, untouched bundle is reused without starting a
 * container, and anything else — missing, edited, extra or downloaded for different sources —
 * is an error naming the only fix. There is no partial repair, because refreshing documentation
 * is whole-bundle deletion (DESIGN.md §18). Attempt-scoped like every non-`run` command: it
 * labels and tears down its own resources and never performs the global startup sweep.
 */
async function docs(
  command: DocsCommand,
  dependencies: ProductionDependencies,
): Promise<CommandResult> {
  const { plan } = await loadPlan(command.planFile);
  const bundleRoot = bundleRootFor(command.planFile);

  if (plan.documentation === undefined) {
    return {
      report: {
        documentation: null,
        sources: [],
        message: `${command.planFile} declares no documentation sources`,
      },
      exitCode: 0,
    };
  }

  const existing = await verifyBundle(bundleRoot, plan.documentation);

  const report = async (fetched: boolean, proxyRecords?: unknown[]): Promise<CommandResult> => ({
    report: {
      documentation: bundleRoot,
      hash: await documentationHash(contextDirFor(bundleRoot)),
      sources: (await readProvenance(bundleRoot)).sources.map((source) => ({
        path: source.path,
        url: source.url,
        hash: source.hash,
        bytes: source.bytes,
        fetched,
      })),
      ...(proxyRecords === undefined ? {} : { proxy_records: proxyRecords }),
    },
    exitCode: 0,
  });

  if (existing.present) return report(false);

  const download = dependencies.download ?? runDocumentationDownload;
  const images = await (dependencies.resolveImages ?? (() => resolveRuntimeImages()))();
  const result = await download({ sources: plan.documentation.sources, images });

  const fetchedAt = new Date().toISOString();
  await writeBundle(
    bundleRoot,
    result.sources.map((source) => ({ ...source, fetchedAt })),
  );

  return report(true, result.proxyRecords);
}

/** Dispatch one parsed command, turning any failure into a report and a non-zero exit. */
export async function execute(
  command: Command,
  dependencies: ProductionDependencies = {},
  signal?: AbortSignal,
): Promise<CommandResult> {
  try {
    if (command.kind === 'prepare') return await prepare(command, dependencies);
    if (command.kind === 'cancel') return await cancel(command);
    if (command.kind === 'docs') return await docs(command, dependencies);
    return await run(command, dependencies, signal);
  } catch (error) {
    return failure(error);
  }
}
