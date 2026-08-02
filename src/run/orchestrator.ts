import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';

import { compileCodexPolicy } from '../adapters/codex/policy.js';
import { runCodexAgent } from '../adapters/codex/run.js';
import { providerSmokeTest } from '../adapters/codex/smoke.js';
import { ArtifactStore } from '../artifacts/store.js';
import { collectSecrets, createRedactor } from '../artifacts/redact.js';
import { readAuthStore, seedAuthStore } from '../auth/store.js';
import { authMount, copyBackAuth, createAuthVolume } from '../auth/volume.js';
import { PROVIDER_ALLOWLIST } from '../config/pins.js';
import { dependencyCacheKey, installCommand, lockfileHash } from '../deps/cache-key.js';
import { DependencyCache, ensureDependencySnapshot } from '../deps/setup.js';
import { createDependencyVolume, dependencyMount } from '../deps/volume.js';
import { sourceDiff } from '../diff/source-diff.js';
import { DiffValidationError, validateChanges } from '../diff/validate.js';
import { resolveRuntimeImages, type RuntimeImages } from '../docker/images.js';
import { acceptChanges } from '../git/accept.js';
import { exportCommit } from '../git/export.js';
import { idempotencyKey } from '../git/idempotency.js';
import { withPhaseNetworks } from '../net/manage.js';
import { proxyEnvironment, withProxy, writeProxyRecords } from '../proxy/container.js';
import { loadTask } from '../task/load.js';
import { runVerification } from '../verify/run.js';
import { attemptLabels, newAttemptId } from '../volume/naming.js';
import { snapshotWorkspace, restoreWorkspace } from '../volume/snapshot.js';
import { initSyntheticGit } from '../volume/synthetic-git.js';
import { createWorkspaceVolume, removeVolume, workspaceMount } from '../volume/workspace.js';
import { CleanupError, describeError, releaseAll, sweepAttempt, withCleanupOutcome } from './cleanup.js';
import { PhaseFailure, type FailureCategory } from './failure.js';
import type { RunInjection } from './inject.js';
import { OwnershipError } from './ownership.js';
import { networkPolicySection, runtimeSection, usageSection } from './manifest.js';
import { resolveTimeouts } from './timeout.js';

/** The Milestone 1 phase order. §21's richer step types arrive with Milestone 2. */
export const RUN_PHASES = [
  'export',
  'setup',
  'workspace',
  'connectivity',
  'agent',
  'diff',
  'verify',
  'commit',
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export interface RunOptions {
  taskFile: string;
  repoPath: string;
  artifactDir: string;
  baseCommit?: string;
  baseBranch?: string;
  sourceCodexHome?: string;
  storeDirectory?: string;
  dependencyCacheDirectory?: string;
  /** Test-only substitution of runtime images and agent environment. See `RunInjection`. */
  injection?: RunInjection;
  onPhase?: (phase: RunPhase) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface RunReport {
  status: 'succeeded' | 'failed';
  attempt: string;
  failedPhase?: RunPhase;
  category?: FailureCategory;
  message?: string;
  commit?: string;
  branch?: string;
  /** Resources the run could not release. Never empty on a report that claims success. */
  cleanupErrors?: string[];
}

const PHASE_CATEGORY: Record<RunPhase, FailureCategory> = {
  export: 'internal_error',
  setup: 'setup_failed',
  workspace: 'internal_error',
  connectivity: 'provider_connectivity_timeout',
  agent: 'agent_failed',
  diff: 'invalid_change',
  verify: 'verification_failed',
  commit: 'internal_error',
};

/** Harness state — credentials and caches — lives outside the artifact directory. */
export function stateDirectory(): string {
  return process.env.HARNESS_STATE_DIR ?? join(homedir(), '.local', 'state', 'ai-harness');
}

function classify(phase: RunPhase, error: unknown): FailureCategory {
  // A cleanup failure wraps the phase failure it happened alongside; the phase failure is
  // still what the run is about, so classification looks through the wrapper.
  const primary = error instanceof OwnershipError ? error.cause : error;

  if (primary instanceof PhaseFailure) return primary.category;
  if (primary instanceof DiffValidationError) return 'invalid_change';
  return PHASE_CATEGORY[phase];
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', ['-C', repoPath, ...args]);
  return stdout;
}

/**
 * Drive one task from export to commit.
 *
 * Every resource is registered for teardown as soon as it exists, and teardown runs in a
 * `finally` in reverse order — so an interrupt or a failure in any phase leaves no
 * attempt-scoped container, volume or network behind.
 */
export async function runTask(options: RunOptions): Promise<RunReport> {
  const attempt = options.injection?.attempt ?? newAttemptId();
  const teardown: (() => Promise<void>)[] = [];
  const snapshots = new ArtifactStore(join(options.artifactDir, 'snapshots'));

  let report: RunReport = { status: 'failed', attempt };
  let current: RunPhase = 'export';
  const manifest: Record<string, unknown> = { attempt };
  let redact = createRedactor([]);

  const phase = async (next: RunPhase): Promise<void> => {
    current = next;
    if (options.signal?.aborted === true) {
      throw new PhaseFailure(next, 'internal_error', 'run was interrupted');
    }
    await options.onPhase?.(next);
  };

  try {
    await phase('export');
    const { task, hash: taskHash } = await loadTask(options.taskFile);
    const baseCommit = options.baseCommit ?? (await git(options.repoPath, ['rev-parse', 'HEAD']));
    const baseBranch =
      options.baseBranch ?? (await git(options.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']));
    // One immutable image set for the whole run: every container below is started from it,
    // and the manifest records this same value rather than a separately resolved one.
    const images: RuntimeImages = await resolveRuntimeImages();

    // Harness-owned helpers keep the verified set even where they use the agent role; only
    // the agent invocation itself is substitutable, and only by a test.
    const agentImages: RuntimeImages = {
      ...images,
      agent: options.injection?.agent ?? images.agent,
    };
    const { tar, hash: exportHash } = await exportCommit(options.repoPath, baseCommit);
    const timeouts = resolveTimeouts(task.timeouts);

    // Recorded now rather than on the success path: a failure manifest without the run's
    // identity cannot be used as evidence of anything.
    manifest.repository = { base_branch: baseBranch, base_commit: baseCommit };
    manifest.runtime = runtimeSection(agentImages);
    const inputs: Record<string, unknown> = {
      task_hash: taskHash,
      export_hash: exportHash,
      ...networkPolicySection(),
    };
    manifest.inputs = inputs;
    const snapshotHashes: Record<string, string> = {};
    manifest.snapshots = snapshotHashes;

    await phase('setup');
    const install = installCommand('denied');
    const cacheKey = dependencyCacheKey({
      setupImageDigest: images.setup.digest,
      lockfileHash: await lockfileHash(options.repoPath, baseCommit),
      installCommand: install,
      lifecycleScripts: 'denied',
    });
    const cache = new DependencyCache(
      options.dependencyCacheDirectory ?? join(stateDirectory(), 'dependency-cache'),
    );
    await withPhaseNetworks(attempt, 'setup', (networks) =>
      ensureDependencySnapshot({
        cache,
        key: cacheKey,
        attempt,
        workspaceTar: tar,
        installCommand: install,
        network: networks.registry ?? 'none',
        images,
        setupSeconds: timeouts.setup_seconds,
        graceSeconds: timeouts.termination_grace_seconds,
      }),
    );
    const dependencySnapshot = await cache.read(cacheKey);
    inputs.dependency_cache_key = cacheKey;

    await phase('workspace');
    const workspace = await createWorkspaceVolume(attempt, tar, images);
    teardown.push(() => removeVolume(workspace));
    await initSyntheticGit(workspace, images, attemptLabels(attempt, 'synthetic-git'));

    const agentDependencies = await createDependencyVolume(
      attempt,
      'agent',
      dependencySnapshot,
      images,
    );
    teardown.push(() => removeVolume(agentDependencies));

    const authStore = await seedAuthStore(
      options.storeDirectory ?? join(stateDirectory(), 'auth'),
      options.sourceCodexHome,
    );
    const stored = await readAuthStore(authStore);
    redact = createRedactor(collectSecrets(stored));

    const policy = compileCodexPolicy({ prompt: task.prompt, workdir: '/workspace' });
    inputs.policy_hash = policy.hash;

    // CODEX_HOME is a per-attempt volume, not a bind of the host store: no host directory is
    // ever mounted into a container, so no host uid mapping is part of the contract.
    const runAuth = await createAuthVolume(attempt, { auth: stored, policy: policy.files }, images);
    teardown.push(() => removeVolume(runAuth));

    const preAgent = await snapshotWorkspace(
      workspace,
      snapshots,
      images,
      attemptLabels(attempt, 'snapshot'),
    );
    snapshotHashes.pre_agent = preAgent.hash;

    const restore = options.injection?.restoreWorkspace
      ?? ((volume, snapshot) =>
        restoreWorkspace(volume, snapshot, images, attemptLabels(attempt, 'restore')));

    /**
     * Put the workspace back the way the agent found it, and record proof that it worked.
     *
     * Every failure from here to the end of validation can leave the workspace half-written:
     * a killed agent, one that exited non-zero, an unparseable event stream, a change that
     * fails scope validation. None of them may hand a dirty workspace to anything downstream.
     * The restored snapshot's hash is stored beside the pre-agent hash so the claim is
     * checkable rather than asserted — equal hashes are the evidence.
     */
    const restorePreAgent = async (error: unknown): Promise<never> => {
      try {
        await restore(workspace, preAgent);
        const restored = await snapshotWorkspace(
          workspace,
          snapshots,
          images,
          attemptLabels(attempt, 'snapshot'),
        );

        manifest.restoration = {
          trigger: classify(current, error),
          pre_agent: preAgent.hash,
          restored: restored.hash,
        };
      } catch (restoreError) {
        // Both survive: the phase failure is what the run is about, and a workspace that
        // could not be restored is a separate fact nobody may discover later.
        throw new OwnershipError(`workspace ${workspace}`, error, restoreError);
      }

      throw error;
    };

    let agentStarted = false;

    // One boundary for everything that can dirty the workspace: the agent invocation and the
    // validation of what it produced. A failure anywhere inside restores before it escapes.
    const runAgentAndValidate = async () => {
      const agentRun = await withPhaseNetworks(attempt, 'agent', (networks) =>
        withProxy(
          {
            attempt,
            egressNetwork: networks.egress ?? '',
            outwardNetwork: networks['proxy-egress'] ?? '',
            allowlist: PROVIDER_ALLOWLIST,
            ports: [443],
            images,
          },
          async (handle) => {
            const proxied = proxyEnvironment(handle);

            try {
              await phase('connectivity');
              await providerSmokeTest({
                url: `https://${PROVIDER_ALLOWLIST[0] ?? 'chatgpt.com'}/`,
                network: networks.egress ?? '',
                env: proxied,
                timeoutSeconds: timeouts.connectivity_smoke_seconds,
                images,
                labels: attemptLabels(attempt, 'connectivity'),
              });

              await phase('agent');
              agentStarted = true;
              return await runCodexAgent({
                prompt: task.prompt,
                policy,
                network: networks.egress ?? '',
                // The harness's own proxy configuration is last: an injected environment
                // may add to the container, never redirect its egress.
                env: { ...options.injection?.agentEnv, ...proxied },
                mounts: [
                  workspaceMount(workspace),
                  dependencyMount(agentDependencies),
                  authMount(runAuth),
                ],
                timeoutSeconds: timeouts.agent_seconds,
                graceSeconds: timeouts.termination_grace_seconds,
                artifactDir: options.artifactDir,
                secrets: collectSecrets(stored),
                images: agentImages,
                labels: attemptLabels(attempt, 'agent'),
              });
            } finally {
              await writeProxyRecords(handle, options.artifactDir);
            }
          },
        ),
      );

      await copyBackAuth(runAuth, authStore, images, {}, attemptLabels(attempt, 'auth-read'));
      manifest.usage = usageSection(agentRun.usage);

      // §32: container logs are artifacts, and they pass through redaction like everything else.
      await writeLog(options.artifactDir, 'agent.log', redact(agentRun.stdout + agentRun.stderr));

      if (agentRun.status !== 'completed') {
        throw new PhaseFailure(
          'agent',
          agentRun.status === 'timeout' ? 'agent_timeout' : 'agent_failed',
          `agent run ${agentRun.status} (exit ${String(agentRun.exitCode)})`,
        );
      }

      await phase('diff');
      const implementation = await snapshotWorkspace(
        workspace,
        snapshots,
        images,
        attemptLabels(attempt, 'snapshot'),
      );
      snapshotHashes.implementation = implementation.hash;
      const changes = await sourceDiff(tar, await snapshots.read(implementation.hash));
      const validated = validateChanges(changes, task.implementation_paths);
      await writeFile(
        join(options.artifactDir, 'source-diff.json'),
        redact(
          `${JSON.stringify(
            validated.changes.map((change) => ({ kind: change.kind, path: change.path })),
            null,
            2,
          )}\n`,
        ),
      );

      return { implementation, validated };
    };

    const { implementation, validated } = await runAgentAndValidate().catch(
      (error: unknown) => (agentStarted ? restorePreAgent(error) : Promise.reject(error)),
    );

    await phase('verify');
    const verification = await runVerification({
      attempt,
      snapshot: implementation,
      dependencySnapshot,
      commands: task.verification.commands,
      artifactDir: options.artifactDir,
      graceSeconds: timeouts.termination_grace_seconds,
      images,
    });

    await writeLog(
      options.artifactDir,
      'verification.log',
      redact(
        verification.commands
          .map((command) => `$ ${command.argv.join(' ')}\n${command.stdout}${command.stderr}`)
          .join('\n'),
      ),
    );

    if (verification.status !== 'pass') {
      throw new PhaseFailure(
        'verify',
        'verification_failed',
        `verification ${verification.status}`,
      );
    }

    await phase('commit');
    const accepted = await acceptChanges({
      repoPath: options.repoPath,
      baseCommit,
      branch: `ai-harness/${task.id}-${attempt}`,
      taskId: task.id,
      attempt,
      idempotencyKey: idempotencyKey({ taskId: task.id, taskHash, baseCommit, attempt }),
      verificationStatus: verification.status,
      changes: validated.changes,
    });

    report = {
      status: 'succeeded',
      attempt,
      commit: accepted.commit,
      branch: accepted.branch,
    };
  } catch (error) {
    report = {
      status: 'failed',
      attempt,
      failedPhase: current,
      category: classify(current, error),
      message: redact(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    // Modules own their resources; this releases what the run registered, then sweeps the
    // attempt label for anything ownership could not reach. Neither may fail quietly.
    const cleanupErrors = await releaseAll(teardown);

    try {
      await sweepAttempt(attempt);
    } catch (error) {
      cleanupErrors.push(
        ...(error instanceof CleanupError ? error.errors : [describeError(error)]),
      );
    }

    report = withCleanupOutcome(report, cleanupErrors.map((error) => redact(error)));

    manifest.result = {
      status: report.status,
      phase: report.failedPhase,
      category: report.category,
      message: report.message,
      commit: report.commit,
      branch: report.branch,
      cleanup_errors: report.cleanupErrors,
    };

    await mkdir(options.artifactDir, { recursive: true });
    await writeFile(
      join(options.artifactDir, 'run-manifest.json'),
      redact(`${JSON.stringify(manifest, null, 2)}\n`),
    );
  }

  return report;
}

async function writeLog(artifactDir: string, name: string, content: string): Promise<void> {
  const logs = join(artifactDir, 'logs');
  await mkdir(logs, { recursive: true });
  await writeFile(join(logs, name), content);
}
