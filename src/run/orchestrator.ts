import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';

import { compileCodexPolicy } from '../adapters/codex/policy.js';
import { implementationPrompt, testWritingPrompt } from '../adapters/codex/prompts.js';
import { runCodexAgent, type AgentRunResult } from '../adapters/codex/run.js';
import { providerSmokeTest } from '../adapters/codex/smoke.js';
import { ArtifactStore } from '../artifacts/store.js';
import { collectSecrets, createRedactor } from '../artifacts/redact.js';
import { readAuthStore, seedAuthStore } from '../auth/store.js';
import { authMount, copyBackAuth, createAuthVolume } from '../auth/volume.js';
import { PROVIDER_ALLOWLIST } from '../config/pins.js';
import { dependencyCacheKey, installCommand, lockfileHash } from '../deps/cache-key.js';
import { DependencyCache, ensureDependencySnapshot } from '../deps/setup.js';
import { createDependencyVolume, dependencyMount } from '../deps/volume.js';
import { manifestFromTar, sourceDiff } from '../diff/source-diff.js';
import { DiffValidationError, validateChanges } from '../diff/validate.js';
import { resolveRuntimeImages, type RuntimeImages } from '../docker/images.js';
import { acceptChanges } from '../git/accept.js';
import { exportCommit } from '../git/export.js';
import { idempotencyKey } from '../git/idempotency.js';
import { withPhaseNetworks } from '../net/manage.js';
import { proxyEnvironment, withProxy, writeProxyRecords } from '../proxy/container.js';
import { loadPlan } from '../plan/load.js';
import { runVerification } from '../verify/run.js';
import { baselineArtifact, captureBaseline } from '../verify/baseline.js';
import { classifyRed, redResultsArtifact } from '../verify/red.js';
import type { TestRunResults } from '../verify/results.js';
import { TestRunError } from '../verify/test-run.js';
import { frozenPathsForPhase, frozenSetEvidence } from '../verify/frozen.js';
import { classifyGreen, greenResultsArtifact } from '../verify/green.js';
import {
  captureTestContractDispute,
  excludeDispute,
  implementationScopeWithDispute,
} from '../verify/dispute.js';
import { attemptLabels, newAttemptId } from '../volume/naming.js';
import { snapshotWorkspace } from '../volume/snapshot.js';
import { initSyntheticGit } from '../volume/synthetic-git.js';
import { createWorkspaceVolume, removeVolume, workspaceMount } from '../volume/workspace.js';
import { singlePlanStep } from './bridge.js';
import { CleanupError, describeError, releaseAll, sweepAttempt, withCleanupOutcome } from './cleanup.js';
import { PhaseFailure, type FailureCategory } from './failure.js';
import type { RunInjection } from './inject.js';
import { OwnershipError } from './ownership.js';
import {
  baselineSection,
  networkPolicySection,
  runtimeSection,
  usageSection,
} from './manifest.js';
import { resolveTimeouts } from './timeout.js';

export const RUN_PHASES = [
  'export',
  'setup',
  'workspace',
  'baseline',
  'connectivity',
  'agent',
  'tests',
  'diff',
  'tests_diff',
  'red',
  'implementation',
  'implementation_diff',
  'green',
  'verify',
  'commit',
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export interface RunOptions {
  planFile: string;
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
  baseline: 'baseline_failed',
  red: 'red_invalid',
  green: 'verification_failed',
  export: 'internal_error',
  setup: 'setup_failed',
  workspace: 'internal_error',
  // Only the smoke test itself can conclude the provider is unreachable, and it raises that
  // category directly. Everything else this phase does — creating the networks, starting the
  // proxy — failing is a harness fault, not a verdict about the provider.
  connectivity: 'internal_error',
  agent: 'agent_failed',
  diff: 'invalid_change',
  tests: 'agent_failed',
  tests_diff: 'invalid_change',
  implementation: 'agent_failed',
  implementation_diff: 'invalid_change',
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
  if (primary instanceof DiffValidationError) {
    return primary.violation === 'closure_violation' ? 'closure_violation' : 'invalid_change';
  }
  return PHASE_CATEGORY[phase];
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', ['-C', repoPath, ...args]);
  return stdout;
}

/**
 * Drive one plan step from export to commit.
 *
 * Every resource is registered for teardown as soon as it exists, and teardown runs in a
 * `finally` in reverse order — so an interrupt or a failure in any phase leaves no
 * attempt-scoped container, volume or network behind.
 */
export async function runStep(options: RunOptions): Promise<RunReport> {
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
    const { plan, hash: planHash } = await loadPlan(options.planFile);
    const step = singlePlanStep(plan);
    const baseCommit = options.baseCommit ?? (await git(options.repoPath, ['rev-parse', 'HEAD']));
    const baseBranch =
      options.baseBranch ?? (await git(options.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']));
    // One immutable image set for the whole run: every container below is started from it,
    // and the manifest records this same value rather than a separately resolved one.
    const images: RuntimeImages = await resolveRuntimeImages();

    // Harness-owned helpers keep the resolved set even where they use the agent role; only
    // the agent invocation itself is substitutable, and only by a test.
    const agentImages: RuntimeImages = {
      ...images,
      agent: options.injection?.agent ?? images.agent,
    };
    const { tar, hash: exportHash } = await exportCommit(options.repoPath, baseCommit);
    const timeouts = resolveTimeouts(step.timeouts);

    // Recorded now rather than on the success path: a failure manifest without the run's
    // identity cannot be used as evidence of anything.
    manifest.repository = { base_branch: baseBranch, base_commit: baseCommit };
    manifest.runtime = runtimeSection(agentImages);
    const inputs: Record<string, unknown> = {
      plan_hash: planHash,
      export_hash: exportHash,
      ...networkPolicySection(),
    };
    manifest.inputs = inputs;
    const snapshotHashes: Record<string, string> = {};
    manifest.snapshots = snapshotHashes;

    await phase('setup');
    const install = installCommand('denied');
    const cacheKey = dependencyCacheKey({
      setupImageId: images.setup.id,
      lockfileHash: await lockfileHash(options.repoPath, baseCommit),
      installCommand: install,
      lifecycleScripts: 'denied',
    });
    const cache = new DependencyCache(
      options.dependencyCacheDirectory ?? join(stateDirectory(), 'dependency-cache'),
    );
    const dependencies = await withPhaseNetworks(attempt, 'setup', (networks) =>
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

    // §32: container logs are artifacts. A warm cache ran no container and has none.
    if (!dependencies.cached) {
      await writeLog(options.artifactDir, 'setup.log', dependencies.output);
    }

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

    const policy = compileCodexPolicy({ prompt: step.observable_behavior, workdir: '/workspace' });
    inputs.policy_hash = policy.hash;

    // CODEX_HOME is a per-attempt volume, not a bind of the host store: no host directory is
    // ever mounted into a container, so no host uid mapping is part of the contract.
    const runAuth = await createAuthVolume(attempt, { auth: stored, policy: policy.files }, images);
    teardown.push(() => removeVolume(runAuth));

    // Pushed *after* the removal so that teardown's reverse order runs it *first*: the volume
    // is deleted only once a rotated credential is safely in the store, or the failure to save
    // it has been recorded. Registered only now, because there is nothing to copy back until
    // seeding has succeeded.
    //
    // In teardown rather than inline because the agent block has several exits — a timeout, a
    // non-zero exit, an unparseable event stream, a failure writing the proxy artifacts — and
    // an inline call covers only the ones that return normally. Codex rotates the refresh
    // token in place, so a rotation dropped here fails some later run with no attributable
    // cause. `releaseAll` collects the error rather than throwing, and a run that could not
    // save a rotated credential does not get to report success.
    teardown.push(async () => {
      await copyBackAuth(runAuth, authStore, images, {}, attemptLabels(attempt, 'auth-read'));
    });

    // Evidence, not a rollback point: the exact workspace the agent was handed, so a run can
    // be reproduced later. A failed attempt's workspace is disposable — it is deleted with
    // the attempt and never handed to anything downstream, so nothing puts it back first.
    const preAgent = await snapshotWorkspace(
      workspace,
      snapshots,
      images,
      attemptLabels(attempt, 'snapshot'),
    );
    snapshotHashes.pre_agent = preAgent.hash;
    let baselineResults: TestRunResults | undefined;

    if (step.type === 'code_behavior') {
      await phase('baseline');
      const baselineDir = join(options.artifactDir, 'baseline');
      const baseline = await captureBaseline({
        policy: {
          retryFailures: step.baseline.retry_failures,
          knownFlakyTests: step.baseline.known_flaky_tests,
        },
        expectedTestIds: step.expected_test_ids,
        run: async (baselineAttempt) => {
          const verification = await runVerification({
            attempt,
            snapshot: preAgent,
            dependencySnapshot,
            commands: [],
            testCommand: step.verification.test_command,
            artifactDir: join(baselineDir, `attempt-${String(baselineAttempt)}`),
            graceSeconds: timeouts.termination_grace_seconds,
            images,
            redact,
          });
          if (verification.testResults === undefined) {
            throw new PhaseFailure(
              'baseline',
              'baseline_failed',
              `baseline test runner ${verification.status}`,
            );
          }
          return verification.testResults;
        },
      });
      const artifact = baselineArtifact(baseline);
      baselineResults = baseline.results;
      manifest.baseline = baselineSection(artifact);
      await mkdir(baselineDir, { recursive: true });
      await writeFile(
        join(baselineDir, 'baseline.json'),
        redact(`${JSON.stringify(artifact, null, 2)}\n`),
      );
      if (baseline.status === 'fail') {
        throw new PhaseFailure(
          'baseline',
          'baseline_failed',
          `baseline failed: ${baseline.failures.join('; ')}`,
        );
      }
    }

    type AgentPhase = 'agent' | 'tests' | 'implementation';

    const runAgentAndValidate = async (
      agentPhase: AgentPhase,
      prompt: string,
      scope: string[],
      beforeTar: Buffer,
      frozenPaths: readonly string[] = [],
    ) => {
      const phaseArtifacts =
        agentPhase === 'agent' ? options.artifactDir : join(options.artifactDir, agentPhase);
      const agentPolicy =
        agentPhase === 'agent'
          ? policy
          : compileCodexPolicy({ prompt, workdir: '/workspace' });

      // Outside the topology, so that a network or proxy that fails to come up is attributed
      // to this phase rather than to the workspace phase that happened to precede it.
      await phase('connectivity');

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
            let outcome: { value: AgentRunResult } | { error: unknown };

            try {
              await providerSmokeTest({
                url: `https://${PROVIDER_ALLOWLIST[0] ?? 'chatgpt.com'}/`,
                network: networks.egress ?? '',
                env: proxied,
                timeoutSeconds: timeouts.connectivity_smoke_seconds,
                images,
                labels: attemptLabels(attempt, 'connectivity'),
              });

              await phase(agentPhase);
              outcome = {
                value: await runCodexAgent({
                  prompt,
                  policy: agentPolicy,
                  network: networks.egress ?? '',
                  // The harness's own proxy configuration is last: an injected environment
                  // may add to the container, never redirect its egress.
                  env: {
                    ...options.injection?.agentEnv,
                    HARNESS_PHASE: agentPhase,
                    ...proxied,
                  },
                  mounts: [
                    workspaceMount(workspace),
                    dependencyMount(agentDependencies),
                    authMount(runAuth),
                  ],
                  timeoutSeconds: timeouts.agent_seconds,
                  graceSeconds: timeouts.termination_grace_seconds,
                  artifactDir: phaseArtifacts,
                  secrets: collectSecrets(stored),
                  images: agentImages,
                  labels: attemptLabels(attempt, agentPhase),
                }),
              };
            } catch (error) {
              outcome = { error };
            }

            // Not in a `finally`: the records are the only evidence of what the agent
            // contacted, so failing to write them fails a run that otherwise succeeded — but
            // it must never displace a failure that was already in flight.
            try {
              await writeProxyRecords(handle, phaseArtifacts);
            } catch (error) {
              if (!('error' in outcome)) throw error;
            }

            if ('error' in outcome) throw outcome.error;
            return outcome.value;
          },
        ),
      );

      const agentUsage = usageSection(agentRun.usage);
      if (step.type === 'code_behavior') {
        const phaseUsage = (manifest.usage ?? {}) as Record<string, unknown>;
        phaseUsage[agentPhase] = agentUsage;
        manifest.usage = phaseUsage;
      } else {
        manifest.usage = agentUsage;
      }

      // §32: container logs are artifacts, and they pass through redaction like everything else.
      await writeLog(phaseArtifacts, 'agent.log', redact(agentRun.stdout + agentRun.stderr));

      if (agentRun.status !== 'completed') {
        throw new PhaseFailure(
          agentPhase,
          agentRun.status === 'timeout' ? 'agent_timeout' : 'agent_failed',
          `agent run ${agentRun.status} (exit ${String(agentRun.exitCode)})`,
        );
      }

      const diffPhase =
        agentPhase === 'agent'
          ? 'diff'
          : agentPhase === 'tests'
            ? 'tests_diff'
            : 'implementation_diff';
      await phase(diffPhase);
      const snapshot = await snapshotWorkspace(
        workspace,
        snapshots,
        images,
        attemptLabels(attempt, 'snapshot'),
      );
      snapshotHashes[agentPhase === 'tests' ? 'tests' : 'implementation'] = snapshot.hash;
      const snapshotTar = await snapshots.read(snapshot.hash);
      const changes = await sourceDiff(beforeTar, snapshotTar);
      const validated = validateChanges(changes, scope, agentPhase, frozenPaths);
      await writeFile(
        join(phaseArtifacts, 'source-diff.json'),
        redact(
          `${JSON.stringify(
            validated.changes.map((change) => ({ kind: change.kind, path: change.path })),
            null,
            2,
          )}\n`,
        ),
      );

      return { snapshot, snapshotTar, validated };
    };

    let implementation;
    let validated;

    if (step.type === 'code_behavior') {
      const testsRun = await runAgentAndValidate(
        'tests',
        testWritingPrompt(step),
        step.test_paths,
        tar,
        frozenPathsForPhase(
          'tests',
          step.verification.closure_paths,
          step.test_paths,
        ),
      );
      await phase('red');
      const redDir = join(options.artifactDir, 'red');
      let redResults: TestRunResults | undefined;
      try {
        const redVerification = await runVerification({
          attempt,
          snapshot: testsRun.snapshot,
          dependencySnapshot,
          commands: [],
          testCommand: step.verification.test_command,
          artifactDir: redDir,
          graceSeconds: timeouts.termination_grace_seconds,
          images,
          redact,
        });
        redResults = redVerification.testResults;
      } catch (error) {
        if (!(error instanceof TestRunError)) throw error;
      }
      if (baselineResults === undefined) {
        throw new Error('code behavior baseline results are missing');
      }
      const redVerdict = classifyRed({
        baseline: baselineResults,
        results: redResults,
        expectedTestIds: step.expected_test_ids,
        allowedRedCategories: step.allowed_red_categories,
        implementationPaths: step.implementation_paths,
      });
      manifest.red = redVerdict;
      await mkdir(redDir, { recursive: true });
      if (redResults !== undefined) {
        await writeFile(
          join(redDir, 'results.json'),
          redact(`${JSON.stringify(redResultsArtifact(redResults), null, 2)}\n`),
        );
      }
      await writeFile(
        join(redDir, 'verdict.json'),
        redact(`${JSON.stringify(redVerdict, null, 2)}\n`),
      );
      if (!redVerdict.valid) {
        throw new PhaseFailure(
          'red',
          'red_invalid',
          `invalid RED: ${redVerdict.reasons.map((reason) => reason.category).join(', ')}`,
        );
      }
      const implementationFrozenPaths = frozenPathsForPhase(
        'implementation',
        step.verification.closure_paths,
        step.test_paths,
      );
      manifest.frozen = frozenSetEvidence(
        await manifestFromTar(testsRun.snapshotTar),
        implementationFrozenPaths,
      );
      const implementationRun = await runAgentAndValidate(
        'implementation',
        implementationPrompt(step),
        implementationScopeWithDispute(step.implementation_paths),
        testsRun.snapshotTar,
        implementationFrozenPaths,
      );
      // Acceptance is cumulative — export → implementation — so the commit carries the tests
      // as well. Each phase was already validated against its own diff, which is a different
      // pairing: validating this one against either phase's scope would reject every run.
      const acceptance = await sourceDiff(tar, implementationRun.snapshotTar);
      const dispute = captureTestContractDispute(implementationRun.validated.changes);
      if (dispute !== undefined) {
        manifest.dispute = dispute;
        await writeFile(
          join(options.artifactDir, 'implementation', 'test-contract-dispute.md'),
          redact(`${dispute.reason}\n`),
        );
        throw new PhaseFailure(
          'implementation',
          'test_contract_disputed',
          `test contract disputed: ${dispute.reason}`,
        );
      }
      implementation = implementationRun.snapshot;
      validated = { changes: excludeDispute(acceptance) };
    } else {
      const run = await runAgentAndValidate(
        'agent',
        step.observable_behavior,
        step.implementation_paths,
        tar,
      );
      implementation = run.snapshot;
      validated = run.validated;
    }

    if (step.type === 'code_behavior') {
      await phase('green');
      const greenDir = join(options.artifactDir, 'green');
      let greenResults: TestRunResults | undefined;
      try {
        const greenVerification = await runVerification({
          attempt,
          snapshot: implementation,
          dependencySnapshot,
          commands: [],
          testCommand: step.verification.test_command,
          artifactDir: greenDir,
          graceSeconds: timeouts.termination_grace_seconds,
          images,
          redact,
        });
        greenResults = greenVerification.testResults;
      } catch (error) {
        if (!(error instanceof TestRunError)) throw error;
      }
      if (baselineResults === undefined) {
        throw new Error('code behavior baseline results are missing');
      }
      const greenVerdict = classifyGreen({
        baseline: baselineResults,
        results: greenResults,
        expectedTestIds: step.expected_test_ids,
      });
      manifest.green = greenVerdict;
      await mkdir(greenDir, { recursive: true });
      if (greenResults !== undefined) {
        await writeFile(
          join(greenDir, 'results.json'),
          redact(`${JSON.stringify(greenResultsArtifact(greenResults), null, 2)}\n`),
        );
      }
      await writeFile(
        join(greenDir, 'verdict.json'),
        redact(`${JSON.stringify(greenVerdict, null, 2)}\n`),
      );
      if (!greenVerdict.valid) {
        throw new PhaseFailure(
          'green',
          'verification_failed',
          `invalid GREEN: ${greenVerdict.reasons.map((reason) => reason.message).join('; ')}`,
        );
      }
    }

    await phase('verify');
    const verification = await runVerification({
      attempt,
      snapshot: implementation,
      dependencySnapshot,
      commands: step.verification.commands,
      artifactDir: options.artifactDir,
      graceSeconds: timeouts.termination_grace_seconds,
      images,
      redact,
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
      branch: `ai-harness/${step.id}-${attempt}`,
      taskId: step.id,
      attempt,
      idempotencyKey: idempotencyKey({ taskId: step.id, taskHash: planHash, baseCommit, attempt }),
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
