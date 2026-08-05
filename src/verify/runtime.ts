import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { execa } from 'execa';

import type { ContainerSpec, Mount } from '../docker/args.js';
import type { RuntimeImages } from '../docker/images.js';
import {
  DEFAULT_GRACE_SECONDS,
  captureContainerLogs,
  removeContainer,
  runContainer,
  startContainer,
  stopContainer,
  type RunOptions,
  type RunResult,
  type RunStatus,
} from '../docker/run.js';
import { withPhaseNetworks } from '../net/manage.js';
import type { RuntimeVerification } from '../plan/schema.js';
import { CleanupError, describeError, releaseAll } from '../run/cleanup.js';
import { OwnershipError } from '../run/ownership.js';
import {
  attemptLabels,
  runtimeContainerName,
  runtimeReadinessContainerName,
} from '../volume/naming.js';
import {
  RUNTIME_COMMAND_TIMEOUT_SECONDS,
  RUNTIME_HOST,
  RUNTIME_READINESS_TIMEOUT_SECONDS,
  RUNTIME_URL_VARIABLE,
} from './runtime-policy.js';

export const RUNTIME_ARTIFACT_DIR = 'runtime';
export const RUNTIME_RESULT_FILE = 'runtime.json';
export const APPLICATION_LOG_FILE = 'application.log';
export const BEHAVIORAL_LOG_FILE = 'behavioral.log';

/**
 * Docker, log capture or artifact writing failed — the harness could not perform the check.
 *
 * Deliberately not a verdict: "the application did not become ready" and "the harness could
 * not start a container" call for different responses, and a check that never ran must not be
 * reported as one the code failed.
 */
export class RuntimeInfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RuntimeInfrastructureError';
  }
}

export type RuntimeStage = 'readiness' | 'behavioral';

export interface RuntimeCommandResult {
  argv: string[];
  exitCode: number;
  status: RunStatus;
  durationMs: number;
}

/**
 * The probe's argv is deliberately not recorded: it is the whole fixed probe source, which
 * would bury the evidence it is stored beside. What identifies this run is the target.
 */
export interface RuntimeReadinessResult {
  url: string;
  exitCode: number;
  status: RunStatus;
  durationMs: number;
  /** The application container was gone before it ever answered. */
  applicationExited?: boolean;
}

export interface RuntimeCheckResult {
  status: 'pass' | 'fail' | 'timeout';
  /** Where a non-passing check stopped. Absent on the passing path. */
  stage?: RuntimeStage;
  /** Present when the stage alone would not explain the verdict. */
  reason?: string;
  startCommand: string[];
  /** What the behavioral checkers receive as `HARNESS_APP_URL`. */
  url: string;
  readinessUrl: string;
  readiness: RuntimeReadinessResult;
  /** Behavioral commands actually run, in order; the list stops at the first failure. */
  commands: RuntimeCommandResult[];
  verifierImage: string;
  /**
   * Set when the check failed *and* teardown failed too. A verification failure is the
   * primary fact and is never replaced by a leak; the leak is recorded beside it.
   */
  cleanupError?: string;
}

export interface RuntimeCheckOptions {
  attempt: string;
  runtime: RuntimeVerification;
  /**
   * The caller's verifier workspace and dependency mounts. Static and runtime verification
   * share one disposable workspace, so a static command may build what `start_command` runs.
   * Ownership stays with the caller: this function creates no volume and removes none.
   */
  mounts: readonly Mount[];
  images: RuntimeImages;
  /** `runtime/` is created inside it. */
  artifactDir: string;
  graceSeconds?: number;
  /** Everything stored passes the attempt's redactor, exactly as §32 requires. */
  redact?: (text: string) => string;
  /** Injectable Docker steps, so every failure and cleanup path is testable. */
  start?: (spec: ContainerSpec) => Promise<string>;
  run?: (spec: ContainerSpec, options: RunOptions) => Promise<RunResult>;
  captureLogs?: (name: string) => Promise<{ stdout: string; stderr: string }>;
  removeContainer?: (name: string) => Promise<void>;
  /** Host-side liveness of the application container; the probe cannot see it. */
  isRunning?: (name: string) => Promise<boolean>;
  /** Ends the readiness probe early. Best-effort: the container ladder is the real deadline. */
  terminate?: (name: string) => Promise<void>;
}

/**
 * The readiness poll loop, as a fixed harness-owned program.
 *
 * One container running this loop, not one `docker run` per poll: container startup is
 * roughly a second, so polling by container would spend the readiness budget on Docker rather
 * than on the application. It is `node -e` rather than a file so that `verifier_image_id` is
 * unchanged — no image rebuild, no re-approval — and so the probe never enters the workspace
 * tree under test.
 *
 * The target URL arrives as a separate argv value; nothing from the plan is interpolated into
 * this source. Exit 3 means the deadline expired, which is the readiness-timeout verdict;
 * any other non-zero exit is the probe itself failing, which is not the same thing.
 */
export const READINESS_PROBE_SOURCE = `
const http = require('node:http');
const url = process.argv[1];
const deadline = Date.now() + Number(process.argv[2]) * 1000;

const attempt = () =>
  new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', (error) => resolve(error.message));
    request.setTimeout(5000, () => {
      request.destroy();
      resolve('request timed out');
    });
  });

(async () => {
  let last = 'no attempt completed';
  while (Date.now() < deadline) {
    const result = await attempt();
    if (result === 200) {
      console.log('ready: ' + url);
      process.exit(0);
    }
    last = String(result);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.error('readiness deadline expired for ' + url + '; last result: ' + last);
  process.exit(3);
})();
`;

/** The probe's own deadline expired, as opposed to the probe failing for another reason. */
const READINESS_DEADLINE_EXIT_CODE = 3;

/** How often the host checks that the application is still alive while readiness polls. */
export const APPLICATION_POLL_INTERVAL_MS = 250;

const APPLICATION_EXITED_REASON =
  'the application exited before it became ready; see application.log';

/** Host-side liveness. A container that no longer exists is not running either. */
async function applicationIsRunning(name: string): Promise<boolean> {
  const { exitCode, stdout } = await execa(
    'docker',
    ['container', 'inspect', '--format', '{{.State.Running}}', name],
    { reject: false },
  );

  return exitCode === 0 && stdout.trim() === 'true';
}

/**
 * Watch the application while readiness polls, and stop the probe the moment it is gone.
 *
 * The probe container has the network and nothing else — no Docker socket, by design — so it
 * cannot tell "not listening yet" from "already dead" and would poll a corpse for its whole
 * budget. Only the host can see the difference, so the host is what watches.
 *
 * Terminating the probe is an optimization, not a correctness requirement: if the kill fails,
 * the §5 container ladder still ends the probe at its deadline. What matters is that the
 * *reason* is recorded either way.
 */
function watchApplication(
  application: string,
  probeContainer: string,
  isRunning: (name: string) => Promise<boolean>,
  terminate: (name: string) => Promise<void>,
  settled: () => boolean,
): { exited: () => boolean; done: Promise<void> } {
  let exited = false;

  const done = (async () => {
    while (!settled()) {
      if (await isRunning(application)) {
        await delay(APPLICATION_POLL_INTERVAL_MS);
        continue;
      }

      // Recorded before the kill is attempted: the application is gone whether or not the
      // probe can be stopped early.
      exited = true;
      try {
        await terminate(probeContainer);
      } catch {
        // Deliberately swallowed. The deadline is the backstop, and a failure to shorten a
        // wait is not a fact about the code under test.
      }
      return;
    }
  })();

  return { exited: () => exited, done };
}

function commandResult(argv: readonly string[], run: RunResult): RuntimeCommandResult {
  return {
    argv: [...argv],
    exitCode: run.exitCode,
    status: run.status,
    durationMs: run.durationMs,
  };
}

function outputOf(header: string, run: RunResult): string {
  return [`$ ${header}`, run.stdout, run.stderr, ''].join('\n');
}

/**
 * Start the application on a private internal network, prove it answers, run the declared
 * behavioral commands against it, and take the whole topology down again.
 *
 * The application and the checkers share only the caller's disposable workspace, its clean
 * dependencies and this network. They receive no provider authentication, no proxy and no
 * egress, and nothing they write can be accepted: acceptance uses the pre-verification
 * implementation snapshot (§15).
 */
export async function runRuntimeCheck(
  options: RuntimeCheckOptions,
): Promise<RuntimeCheckResult> {
  const start = options.start ?? startContainer;
  const run = options.run ?? runContainer;
  const captureLogs = options.captureLogs ?? captureContainerLogs;
  const release = options.removeContainer ?? removeContainer;
  const isRunning = options.isRunning ?? applicationIsRunning;
  // Tolerant on purpose: this only shortens a wait, and `runContainer` removes the probe
  // container itself either way.
  const terminate = options.terminate ?? stopContainer;
  const redact = options.redact ?? ((text: string) => text);
  const graceSeconds = options.graceSeconds ?? DEFAULT_GRACE_SECONDS;

  const application = runtimeContainerName(options.attempt);
  const url = `http://${application}:${options.runtime.port}`;
  const readinessUrl = `${url}${options.runtime.readiness_path}`;
  const mounts = [...options.mounts];

  return withPhaseNetworks(options.attempt, 'runtime', async (networks) => {
    const network = networks.runtime;
    if (network === undefined) {
      throw new RuntimeInfrastructureError('the runtime phase created no network');
    }

    let outcome: { value: RuntimeCheckResult } | { error: unknown };
    let applicationLog = '';
    let behavioralLog = '';
    let started = false;

    try {
      await start({
        image: options.images.verifier.id,
        argv: [...options.runtime.start_command],
        network,
        name: application,
        autoRemove: false,
        mounts,
        labels: attemptLabels(options.attempt, 'runtime-app'),
        env: { HOST: RUNTIME_HOST, PORT: String(options.runtime.port) },
      });
      started = true;

      const probeContainer = runtimeReadinessContainerName(options.attempt);
      const probe = run(
        {
          image: options.images.verifier.id,
          argv: [
            'node',
            '-e',
            READINESS_PROBE_SOURCE,
            readinessUrl,
            String(RUNTIME_READINESS_TIMEOUT_SECONDS),
          ],
          network,
          name: probeContainer,
          labels: attemptLabels(options.attempt, 'runtime-readiness'),
          env: { [RUNTIME_URL_VARIABLE]: url },
        },
        { timeoutSeconds: RUNTIME_READINESS_TIMEOUT_SECONDS, graceSeconds },
      );

      let probeSettled = false;
      const watch = watchApplication(
        application,
        probeContainer,
        isRunning,
        terminate,
        () => probeSettled,
      );

      let readinessRun: RunResult;
      try {
        readinessRun = await probe;
      } finally {
        probeSettled = true;
      }
      await watch.done;

      const applicationExited = watch.exited();
      const readiness: RuntimeReadinessResult = {
        url: readinessUrl,
        exitCode: readinessRun.exitCode,
        status: readinessRun.status,
        durationMs: readinessRun.durationMs,
        ...(applicationExited ? { applicationExited } : {}),
      };
      behavioralLog += outputOf(`readiness probe ${readinessUrl}`, readinessRun);

      const result: RuntimeCheckResult = {
        status: 'pass',
        startCommand: [...options.runtime.start_command],
        url,
        readinessUrl,
        readiness,
        commands: [],
        verifierImage: options.images.verifier.id,
      };

      if (applicationExited) {
        // The most specific fact wins the verdict: this is not a deadline that expired, it is
        // a process that died. The probe's own outcome stays recorded beside it.
        result.status = 'fail';
        result.stage = 'readiness';
        result.reason = APPLICATION_EXITED_REASON;
      } else if (
        readinessRun.status === 'timeout' ||
        readinessRun.exitCode === READINESS_DEADLINE_EXIT_CODE
      ) {
        result.status = 'timeout';
        result.stage = 'readiness';
      } else if (readinessRun.exitCode !== 0) {
        result.status = 'fail';
        result.stage = 'readiness';
      }

      for (const argv of result.status === 'pass' ? options.runtime.behavioral_commands : []) {
        const behavioral = await run(
          {
            image: options.images.verifier.id,
            argv: [...argv],
            network,
            mounts,
            labels: attemptLabels(options.attempt, 'runtime-check'),
            env: { [RUNTIME_URL_VARIABLE]: url },
          },
          { timeoutSeconds: RUNTIME_COMMAND_TIMEOUT_SECONDS, graceSeconds },
        );

        result.commands.push(commandResult(argv, behavioral));
        behavioralLog += outputOf(argv.join(' '), behavioral);

        if (behavioral.status === 'timeout') {
          result.status = 'timeout';
          result.stage = 'behavioral';
          break;
        }

        if (behavioral.exitCode !== 0) {
          result.status = 'fail';
          result.stage = 'behavioral';
          break;
        }
      }

      outcome = { value: result };
    } catch (error) {
      outcome = {
        error: new RuntimeInfrastructureError(
          `runtime check could not run: ${describeError(error)}`,
          { cause: error },
        ),
      };
    }

    // Evidence before teardown: the retained container exists precisely so that an
    // application which crashed on startup can still explain itself.
    if (started) {
      try {
        const logs = await captureLogs(application);
        applicationLog = `${logs.stdout}${logs.stderr}`;
      } catch (error) {
        if (!('error' in outcome)) {
          outcome = {
            error: new RuntimeInfrastructureError(
              `runtime check could not capture application logs: ${describeError(error)}`,
              { cause: error },
            ),
          };
        }
      }
    }

    const cleanupErrors = started ? await releaseAll([() => release(application)]) : [];

    // Artifacts are written even for a failed check: the failure is what the evidence is for.
    try {
      await writeArtifacts(options.artifactDir, redact, {
        result: 'value' in outcome ? outcome.value : undefined,
        applicationLog,
        behavioralLog,
      });
    } catch (error) {
      if (!('error' in outcome)) {
        outcome = {
          error: new RuntimeInfrastructureError(
            `runtime check could not write its evidence: ${describeError(error)}`,
            { cause: error },
          ),
        };
      }
    }

    if (cleanupErrors.length > 0) {
      const cleanup = new CleanupError(cleanupErrors);

      if ('error' in outcome) {
        throw new OwnershipError(`runtime application ${application}`, outcome.error, cleanup);
      }

      // A check that already failed keeps its verdict; the leak is recorded, not substituted.
      if (outcome.value.status !== 'pass') {
        return { ...outcome.value, cleanupError: cleanup.message };
      }

      throw cleanup;
    }

    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  });
}

async function writeArtifacts(
  artifactDir: string,
  redact: (text: string) => string,
  evidence: {
    result: RuntimeCheckResult | undefined;
    applicationLog: string;
    behavioralLog: string;
  },
): Promise<void> {
  const dir = join(artifactDir, RUNTIME_ARTIFACT_DIR);
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, APPLICATION_LOG_FILE), redact(evidence.applicationLog));
  await writeFile(join(dir, BEHAVIORAL_LOG_FILE), redact(evidence.behavioralLog));

  if (evidence.result !== undefined) {
    await writeFile(
      join(dir, RUNTIME_RESULT_FILE),
      redact(`${JSON.stringify(evidence.result, null, 2)}\n`),
    );
  }
}
