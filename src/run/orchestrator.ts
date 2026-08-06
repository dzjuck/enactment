import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PlanStep } from '../plan/schema.js';
import { implementationPrompt, testWritingPrompt } from '../adapters/codex/prompts.js';
import { providerDescriptor } from '../adapters/provider.js';
import { providerSmokeTest } from '../adapters/codex/smoke.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { collectSecrets, createRedactor } from '../artifacts/redact.js';
import { readAuthStore, seedAuthStore } from '../auth/store.js';
import { authMount, copyBackAuth, createAuthVolume } from '../auth/volume.js';
import { claudeTokenSecrets, loadClaudeToken } from '../auth/claude-token.js';
import { dependencyCacheKey, installCommand, lockfileHash } from '../deps/cache-key.js';
import { DependencyCache, ensureDependencySnapshot } from '../deps/setup.js';
import {
  cloneDependencyVolume,
  createDependencyTemplate,
  dependencyMount,
} from '../deps/volume.js';
import { manifestFromTar, sourceDiff } from '../diff/source-diff.js';
import { DiffValidationError, validateChanges } from '../diff/validate.js';
import type { RuntimeImages } from '../docker/images.js';
import { acceptChanges } from '../git/accept.js';
import { exportCommit } from '../git/export.js';
import { withPhaseNetworks } from '../net/manage.js';
import { runReview } from '../review/run.js';
import { proxyEnvironment, withProxy, writeProxyRecords } from '../proxy/container.js';
import {
  DEFAULT_VERIFICATION_TIMEOUT_SECONDS,
  runVerification,
  runWorkspaceCommands,
  withVerifierWorkspace,
  writeVerificationArtifact,
  type VerificationResult,
} from '../verify/run.js';
import { runRuntimeCheck } from '../verify/runtime.js';
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
import { attemptLabels, workspaceVolumeName } from '../volume/naming.js';
import { snapshotWorkspace } from '../volume/snapshot.js';
import { initSyntheticGit } from '../volume/synthetic-git.js';
import { createWorkspaceVolume, removeVolume, workspaceMount } from '../volume/workspace.js';
import type { AttemptPhase } from '../state/store.js';
import type { AgentProfile } from '../routing/profiles.js';
import { stateDirectory } from '../state/paths.js';
import { CleanupError, describeError, releaseAll, sweepAttempt, withCleanupOutcome } from './cleanup.js';
import { PhaseFailure, type FailureCategory } from './failure.js';
import type { RunInjection } from './inject.js';
import { OwnershipError } from './ownership.js';
import {
  baselineSection,
  networkPolicySection,
  runtimeCheckSection,
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
  'runtime',
  'review',
  'commit',
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

/**
 * What a step executor reports back for the state store: the diagnostic phase it reached,
 * the verified acceptance candidate, and the moment acceptance begins.
 *
 * One narrow callback rather than three: the coordinator is the only consumer and it wants
 * these in order, not as three independently sequenced hooks.
 */
export type StepEvent =
  | { kind: 'phase'; phase: AttemptPhase }
  | { kind: 'candidate'; snapshot: string }
  | { kind: 'accepting' };

export type OnStepEvent = (event: StepEvent) => void | Promise<void>;

/**
 * Everything one step needs, all of it already approved and resolved by the caller.
 *
 * The executor loads no plan, resolves no image and reads no repository head: what it runs
 * is exactly what the approval covered, and there is no second resolution that could differ
 * from the one recorded in the manifest.
 */
export interface StepExecutionOptions {
  step: PlanStep;
  profile: AgentProfile;
  planId: string;
  /** Identity of the approval this step is executing under. */
  planHash: string;
  manifestHash: string;
  images: RuntimeImages;

  repoPath: string;
  baseBranch: string;
  /** The commit this step builds on: the approved base, or the previous accepted commit. */
  parentCommit: string;
  branch: string;
  branchExists: boolean;

  attempt: string;
  idempotencyKey: string;

  /** This attempt run's evidence directory. */
  artifactDir: string;
  /** Plan-scoped and shared by every attempt: snapshots are content-addressed. */
  snapshots: ArtifactStore;

  sourceCodexHome?: string;
  claudeTokenFile?: string;
  storeDirectory?: string;
  dependencyCacheDirectory?: string;
  /** Harness-owned context for a stronger retry; never changes scope or verification. */
  advisoryContext?: string;
  /** Test-only substitution of runtime images and agent environment. See `RunInjection`. */
  injection?: RunInjection;
  onPhase?: (phase: RunPhase) => void | Promise<void>;
  onEvent?: OnStepEvent;
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

function withAdvisory(prompt: string, advisory: string | undefined): string {
  if (advisory === undefined || advisory.trim() === '') return prompt;
  return `${prompt}\n\n--- Stronger retry advisory (evidence only) ---\n${advisory.slice(0, 4_000)}`;
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
  // A failing runtime *verdict* raises `verification_failed` itself. What is left here is the
  // harness failing to perform the check at all — Docker, log capture, artifact writing —
  // which is a harness fault, not a statement about the code.
  runtime: 'internal_error',
  review: 'review_failed',
  commit: 'internal_error',
};

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

/** The diagnostic phase each execution phase reports to the state store. */
const ATTEMPT_PHASE: Record<RunPhase, AttemptPhase> = {
  export: 'preparing',
  setup: 'preparing',
  workspace: 'preparing',
  connectivity: 'preparing',
  baseline: 'baseline',
  tests: 'tests',
  tests_diff: 'tests',
  red: 'red',
  agent: 'implementation',
  diff: 'implementation',
  implementation: 'implementation',
  implementation_diff: 'implementation',
  green: 'green',
  verify: 'verify',
  runtime: 'runtime',
  review: 'review',
  commit: 'review',
};

/**
 * Drive one plan step from export to commit.
 *
 * Every input is supplied already approved and resolved — the step, the images, the parent
 * commit, the attempt id, the idempotency key — so nothing here can execute against a value
 * the approval did not cover.
 *
 * Every resource is registered for teardown as soon as it exists, and teardown runs in a
 * `finally` in reverse order — so an interrupt or a failure in any phase leaves no
 * attempt-scoped container, volume or network behind.
 */
export async function runStep(options: StepExecutionOptions): Promise<RunReport> {
  const { attempt, step, profile, images, snapshots } = options;
  const baseCommit = options.parentCommit;
  const teardown: (() => Promise<void>)[] = [];

  let report: RunReport = { status: 'failed', attempt };
  let current: RunPhase = 'export';
  const manifest: Record<string, unknown> = { attempt };
  let redact = createRedactor([]);
  let reported: AttemptPhase | undefined;

  const phase = async (next: RunPhase): Promise<void> => {
    current = next;
    if (options.signal?.aborted === true) {
      throw new PhaseFailure(next, 'internal_error', 'run was interrupted');
    }
    // Reported on entering the phase, before the phase runs: the stored value has to name
    // where the attempt was when it died, and a phase that fails immediately was still
    // reached. Deduplicated, because several execution phases share one diagnostic phase and
    // the state store wants progress, not one write per container.
    const diagnostic = ATTEMPT_PHASE[next];
    if (diagnostic !== reported) {
      reported = diagnostic;
      await options.onEvent?.({ kind: 'phase', phase: diagnostic });
    }

    await options.onPhase?.(next);
  };

  try {
    await phase('export');
    // Harness-owned helpers keep the approved set even where they use the Codex image; only
    // the model invocation itself is substitutable, and only by a test.
    const descriptor = providerDescriptor(profile);
    const injectedImage =
      descriptor.provider === 'codex' ? options.injection?.codex : options.injection?.claude;
    const agentImages: RuntimeImages = {
      ...images,
      [descriptor.provider]: injectedImage ?? descriptor.image(images),
    };
    const { tar, hash: exportHash } = await exportCommit(options.repoPath, baseCommit);
    const timeouts = resolveTimeouts(step.timeouts);

    // Recorded now rather than on the success path: a failure manifest without the run's
    // identity cannot be used as evidence of anything.
    manifest.repository = { base_branch: options.baseBranch, base_commit: baseCommit };
    manifest.runtime = runtimeSection(agentImages);
    const inputs: Record<string, unknown> = {
      plan_hash: options.planHash,
      export_hash: exportHash,
      ...networkPolicySection(descriptor.allowlist, descriptor.cliVersion),
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

    // Seeded once and cloned per phase. The tar is a host buffer, so extracting it costs a
    // transfer across the Docker API; every phase after the first now copies inside the VM
    // instead. Each phase still gets its own pristine volume, which is what §12 requires.
    const dependencyTemplate = await createDependencyTemplate(attempt, dependencySnapshot, images);
    teardown.push(() => removeVolume(dependencyTemplate));

    const agentDependencies = await cloneDependencyVolume(
      dependencyTemplate,
      attempt,
      'agent',
      images,
    );
    teardown.push(() => removeVolume(agentDependencies));

    const policy = descriptor.compile(withAdvisory(step.observable_behavior, options.advisoryContext));
    inputs.policy_hash = policy.hash;
    let runAuth: string;
    let secrets: string[];
    if (descriptor.provider === 'codex') {
      const authStore = await seedAuthStore(
        options.storeDirectory ?? join(stateDirectory(), 'auth'),
        options.sourceCodexHome,
      );
      const stored = await readAuthStore(authStore);
      secrets = collectSecrets(stored);
      runAuth = await createAuthVolume(
        attempt,
        { provider: 'codex', auth: stored, policy: policy.files },
        images,
      );
      teardown.push(() => removeVolume(runAuth));
      teardown.push(async () => {
        await copyBackAuth(
          runAuth,
          authStore,
          images,
          {},
          attemptLabels(attempt, 'auth-read'),
        );
      });
    } else {
      const token = await loadClaudeToken(options.claudeTokenFile);
      secrets = claudeTokenSecrets(token);
      runAuth = await createAuthVolume(
        attempt,
        { provider: 'claude', token },
        images,
      );
      teardown.push(() => removeVolume(runAuth));
    }
    redact = createRedactor(secrets);

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
            dependencyTemplate,
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
          : descriptor.compile(prompt);

      // Outside the topology, so that a network or proxy that fails to come up is attributed
      // to this phase rather than to the workspace phase that happened to precede it.
      await phase('connectivity');

      const agentRun = await withPhaseNetworks(attempt, 'agent', (networks) =>
        withProxy(
          {
            attempt,
            egressNetwork: networks.egress ?? '',
            outwardNetwork: networks['proxy-egress'] ?? '',
            allowlist: descriptor.allowlist,
            ports: [443],
            images,
          },
          async (handle) => {
            const proxied = proxyEnvironment(handle);
            let outcome: { value: Awaited<ReturnType<typeof descriptor.run>> } | { error: unknown };

            try {
              // The smoke test asks whether the *provider* is reachable. When the provider
              // has been substituted there is no provider to reach, and asking anyway made
              // the stubbed suites depend on live egress to chatgpt.com — twice per
              // tests-first step. `providerSmokeTest` itself stays covered against a local
              // origin in `test/docker/smoke-timeout.test.ts`, and injection is test-only and
              // unreachable from the CLI (see `RunInjection`).
              if (injectedImage === undefined) {
                await providerSmokeTest({
                  url: `https://${descriptor.allowlist[0] ?? ''}/`,
                  network: networks.egress ?? '',
                  env: proxied,
                  timeoutSeconds: timeouts.connectivity_smoke_seconds,
                  images,
                  provider: descriptor.provider,
                  labels: attemptLabels(attempt, 'connectivity'),
                });
              }

              await phase(agentPhase);
              outcome = {
                value: await descriptor.run({
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
                    authMount(descriptor.authProvider, runAuth),
                  ],
                  timeoutSeconds: timeouts.agent_seconds,
                  graceSeconds: timeouts.termination_grace_seconds,
                  artifactDir: phaseArtifacts,
                  secrets,
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

      const agentRuns = (manifest.agent_runs ?? {}) as Record<string, unknown>;
      agentRuns[agentPhase] = {
        profile: profile.id,
        provider: descriptor.provider,
        cli_version: descriptor.cliVersion,
        requested_model: profile.model,
        reported_model: agentRun.reportedModel,
        effort: profile.effort,
      };
      manifest.agent_runs = agentRuns;

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

      // Codex only: DESIGN §35 measured `gpt-5.1-codex-max` logging "model metadata not found"
      // and falling back, which is exactly what this catches. Claude has no such signal — it
      // refuses instead — so its reported name is evidence, not a gate (§27, `events.ts`).
      if (
        descriptor.provider === 'codex' &&
        agentRun.reportedModel !== null &&
        agentRun.reportedModel !== profile.model
      ) {
        throw new PhaseFailure(
          agentPhase,
          'agent_failed',
          `provider reported model ${agentRun.reportedModel}, requested ${profile.model}`,
        );
      }

      if (agentRun.status !== 'completed') {
        throw new PhaseFailure(
          agentPhase,
          agentRun.status === 'timeout'
            ? 'agent_timeout'
            : (agentRun.failureCategory ?? 'agent_failed'),
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
        withAdvisory(testWritingPrompt(step), options.advisoryContext),
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
          dependencyTemplate,
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
        withAdvisory(implementationPrompt(step), options.advisoryContext),
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
        withAdvisory(step.observable_behavior, options.advisoryContext),
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
          dependencyTemplate,
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
    const runtimeBlock = step.verification.runtime;

    // One acquisition for both checks: a static command may build exactly what
    // `start_command` launches, and a second restore would discard that build output.
    const verified = await withVerifierWorkspace(
      { attempt, snapshot: implementation, dependencySnapshot, dependencyTemplate, images },
      async (workspace) => {
        const commands = await runWorkspaceCommands({
          attempt,
          mounts: workspace.mounts,
          commands: step.verification.commands,
          artifactDir: options.artifactDir,
          images,
          timeoutSeconds: DEFAULT_VERIFICATION_TIMEOUT_SECONDS,
          graceSeconds: timeouts.termination_grace_seconds,
          redact,
        });

        if (commands.status !== 'pass' || runtimeBlock === undefined) return { commands };

        await phase('runtime');
        const runtimeCheck = await runRuntimeCheck({
          attempt,
          runtime: runtimeBlock,
          mounts: workspace.mounts,
          images,
          artifactDir: options.artifactDir,
          graceSeconds: timeouts.termination_grace_seconds,
          redact,
        });

        return { commands, runtimeCheck };
      },
    );

    const verification: VerificationResult = {
      ...verified.commands,
      workspaceVolume: workspaceVolumeName(`${attempt}-verify`),
    };
    await writeVerificationArtifact(options.artifactDir, verification, redact);

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

    const runtimeCheck = verified.runtimeCheck;
    if (runtimeCheck !== undefined) {
      manifest.runtime_check = runtimeCheckSection(runtimeCheck);

      // A leak that happened alongside a failed check is recorded in the manifest above and
      // swept below; it does not become the reason the step failed. A leak beside a *passing*
      // check raises its own cleanup error out of `runRuntimeCheck`, so there is nothing to
      // check for here.
      if (runtimeCheck.status !== 'pass') {
        throw new PhaseFailure(
          'runtime',
          'verification_failed',
          // The reason is carried into the report so an operator learns what happened without
          // having to open an artifact first.
          `runtime ${runtimeCheck.stage ?? 'check'} ${runtimeCheck.status}` +
            (runtimeCheck.reason === undefined ? '' : `: ${runtimeCheck.reason}`),
        );
      }
    }

    await phase('review');
    const review = await runReview({
      attempt,
      risk: step.risk,
      changes: validated,
      artifactDir: join(options.artifactDir, 'review'),
      images,
      graceSeconds: timeouts.termination_grace_seconds,
      redact,
    });
    manifest.review = {
      risk: review.risk,
      verdict: review.verdict,
      counts: review.counts,
      reviewer_image_id: review.reviewerImageId,
      scanned_paths: review.scannedPaths,
      duration_ms: review.durationMs,
    };

    if (review.verdict === 'blocked') {
      const blocking = review.findings.filter(
        (finding) => finding.severity === 'critical' || step.risk === 'high',
      );
      const shown = blocking
        .slice(0, 10)
        .map((finding) => `${finding.ruleId} at ${finding.path}`)
        .join('; ');
      const omitted = blocking.length > 10 ? `; ${String(blocking.length - 10)} more` : '';
      throw new PhaseFailure('review', 'review_blocked', `review blocked: ${shown}${omitted}`);
    }

    await phase('commit');
    // Recorded before acceptance begins: a crash between here and the commit leaves a
    // verified candidate the next run can accept without asking a model for anything.
    snapshotHashes.candidate = implementation.hash;
    await options.onEvent?.({ kind: 'candidate', snapshot: implementation.hash });
    await options.onEvent?.({ kind: 'accepting' });

    const accepted = await acceptChanges({
      repoPath: options.repoPath,
      parentCommit: baseCommit,
      branchExists: options.branchExists,
      branch: options.branch,
      planId: options.planId,
      stepId: step.id,
      attempt,
      idempotencyKey: options.idempotencyKey,
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
