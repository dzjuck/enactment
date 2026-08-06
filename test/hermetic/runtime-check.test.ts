import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IMAGE_ROLES } from '../../src/config/pins.js';
import { buildRunArgs, type ContainerSpec, type Mount } from '../../src/docker/args.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import type { RunOptions, RunResult } from '../../src/docker/run.js';
import type { RuntimeVerification } from '../../src/plan/schema.js';
import { CleanupError } from '../../src/run/cleanup.js';
import { OwnershipError } from '../../src/run/ownership.js';
import {
  APPLICATION_LOG_FILE,
  BEHAVIORAL_LOG_FILE,
  RUNTIME_ARTIFACT_DIR,
  RUNTIME_RESULT_FILE,
  RuntimeInfrastructureError,
  runRuntimeCheck,
  type RuntimeCheckResult,
} from '../../src/verify/runtime.js';
import {
  RUNTIME_COMMAND_TIMEOUT_SECONDS,
  RUNTIME_READINESS_TIMEOUT_SECONDS,
} from '../../src/verify/runtime-policy.js';
import {
  ATTEMPT_LABEL,
  ROLE_LABEL,
  runtimeContainerName,
  runtimeReadinessContainerName,
} from '../../src/volume/naming.js';

const { dockerCalls, dockerFailure, fakeExeca } = vi.hoisted(() => {
  const recorded: string[][] = [];
  const failure: { match?: string; stderr?: string } = {};

  const fake = (_file: string, args: string[]): Promise<{ exitCode: number; stderr: string }> => {
    recorded.push(args);

    if (failure.match !== undefined && args.join(' ').includes(failure.match)) {
      const error = Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), {
        exitCode: 1,
        stderr: failure.stderr ?? '',
      });
      return Promise.reject(error);
    }

    return Promise.resolve({ exitCode: 0, stderr: '' });
  };

  return { dockerCalls: recorded, dockerFailure: failure, fakeExeca: fake };
});

vi.mock('execa', () => ({ execa: fakeExeca }));

const IMAGES = Object.fromEntries(
  IMAGE_ROLES.map((role, index) => [role, { role, id: `sha256:${String(index + 1).repeat(64)}` }]),
) as RuntimeImages;

const ATTEMPT = 'attempt-1';
const APP = runtimeContainerName(ATTEMPT);
const NETWORK = `ai-harness-net-${ATTEMPT}-runtime`;

const RUNTIME: RuntimeVerification = {
  start_command: ['node', 'dist/server.js'],
  port: 3000,
  readiness_path: '/health',
  behavioral_commands: [
    ['node', 'harness-checks/orders.mjs'],
    ['node', 'harness-checks/health.mjs'],
  ],
};

const MOUNTS: Mount[] = [
  { type: 'volume', source: 'ai-harness-ws-attempt-1-verify', target: '/workspace' },
  {
    type: 'volume',
    source: 'ai-harness-deps-attempt-1-verify-verifier',
    target: '/workspace/node_modules',
  },
];

function ok(overrides: Partial<RunResult> = {}): RunResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutBytes: Buffer.alloc(0),
    durationMs: 5,
    status: 'completed',
    ...overrides,
  };
}

interface Recorder {
  started: ContainerSpec[];
  ran: { spec: ContainerSpec; options: RunOptions }[];
  events: string[];
}

let dir: string;
let recorder: Recorder;

beforeEach(async () => {
  dockerCalls.length = 0;
  delete dockerFailure.match;
  delete dockerFailure.stderr;
  dir = await mkdtemp(join(tmpdir(), 'harness-runtime-'));
  recorder = { started: [], ran: [], events: [] };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Overrides = Partial<Parameters<typeof runRuntimeCheck>[0]>;

function check(overrides: Overrides = {}): Promise<RuntimeCheckResult> {
  return runRuntimeCheck({
    attempt: ATTEMPT,
    runtime: RUNTIME,
    mounts: [...MOUNTS],
    images: IMAGES,
    artifactDir: dir,
    start: async (spec) => {
      recorder.started.push(spec);
      recorder.events.push('start');
      return spec.name ?? 'unnamed';
    },
    run: async (spec, options) => {
      recorder.ran.push({ spec, options });
      recorder.events.push(`run:${recorder.ran.length}`);
      return ok();
    },
    captureLogs: async () => {
      recorder.events.push('logs');
      return { stdout: 'listening on 0.0.0.0:3000\n', stderr: '' };
    },
    removeContainer: async () => {
      recorder.events.push('remove');
    },
    // Deliberately not recorded in `events`: polling is concurrent with the probe, so it
    // carries no ordering meaning and would only add noise to the sequence assertions.
    isRunning: async () => true,
    terminate: async (name) => {
      recorder.events.push(`terminate:${name}`);
    },
    ...overrides,
  });
}

/**
 * A probe that does not settle until something terminates it — which is what a real one does
 * while polling a dead application: it waits out its whole deadline.
 */
function heldProbe(): { probe: Promise<RunResult>; release: (result: RunResult) => void } {
  let release: (result: RunResult) => void = () => undefined;
  const probe = new Promise<RunResult>((resolve) => {
    release = resolve;
  });
  return { probe, release };
}

/** Behavioral outcomes by index, readiness first. */
function runs(results: RunResult[]): Overrides['run'] {
  return async (spec, options) => {
    recorder.ran.push({ spec, options });
    recorder.events.push(`run:${recorder.ran.length}`);
    return results[recorder.ran.length - 1] ?? ok();
  };
}

async function readArtifact(name: string): Promise<string> {
  return readFile(join(dir, RUNTIME_ARTIFACT_DIR, name), 'utf8');
}

describe('runtime check naming and topology', () => {
  it('names the application container and its network per attempt', async () => {
    await check();

    expect(APP).toBe('ai-harness-app-attempt-1');
    expect(recorder.started[0]?.name).toBe(APP);
    expect(recorder.started[0]?.network).toBe(NETWORK);
    expect(recorder.started[0]?.labels).toEqual({
      [ATTEMPT_LABEL]: ATTEMPT,
      [ROLE_LABEL]: 'runtime-app',
    });
  });

  it('creates exactly one internal network and removes it afterwards', async () => {
    await check();

    const created = dockerCalls.filter((args) => args[0] === 'network' && args[1] === 'create');
    expect(created).toHaveLength(1);
    expect(created[0]).toContain('--internal');
    expect(created[0]).toContain(NETWORK);
    expect(created[0]).toContain(`${ATTEMPT_LABEL}=${ATTEMPT}`);

    expect(dockerCalls).toContainEqual(['network', 'rm', NETWORK]);
  });
});

describe('runtime application container', () => {
  it('runs the declared start command from the verifier image with the caller mounts', async () => {
    await check();

    const spec = recorder.started[0];
    expect(spec?.image).toBe(IMAGES.verifier.id);
    expect(spec?.argv).toEqual(['node', 'dist/server.js']);
    expect(spec?.mounts).toEqual(MOUNTS.map((mount) => ({ ...mount, readonly: true })));
    expect(spec?.env).toEqual({ HOST: '0.0.0.0', PORT: '3000' });
  });

  it('is detached and retained, so a crash leaves logs to read', async () => {
    await check();

    const spec = recorder.started[0];
    if (spec === undefined) throw new Error('no application container was started');

    expect(spec.autoRemove).toBe(false);
    const argv = buildRunArgs({ ...spec, detach: true });
    expect(argv).not.toContain('--rm');
    expect(argv).toContain('--detach');
  });
});

describe('readiness', () => {
  it('polls from one container, with the target as argv and the base URL in the environment', async () => {
    await check();

    // One readiness container, not one per poll.
    const readiness = recorder.ran[0];
    if (readiness === undefined) throw new Error('readiness did not run');

    expect(readiness.spec.image).toBe(IMAGES.verifier.id);
    expect(readiness.spec.network).toBe(NETWORK);
    expect(readiness.spec.argv[0]).toBe('node');
    expect(readiness.spec.argv[1]).toBe('-e');
    // The validated URL is a separate argv value, never interpolated into the probe source.
    expect(readiness.spec.argv).toContain(`http://${APP}:3000/health`);
    expect(readiness.spec.argv[2]).not.toContain(APP);
    expect(readiness.spec.env?.HARNESS_APP_URL).toBe(`http://${APP}:3000`);
    expect(readiness.options.timeoutSeconds).toBe(RUNTIME_READINESS_TIMEOUT_SECONDS);
  });

  it('reports a readiness timeout without running any behavioral command', async () => {
    const result = await check({ run: runs([ok({ status: 'timeout', exitCode: 137 })]) });

    expect(result.status).toBe('timeout');
    expect(result.stage).toBe('readiness');
    expect(result.commands).toEqual([]);
    expect(recorder.ran).toHaveLength(1);
  });

  it('reports the probe own expired deadline as a readiness timeout', async () => {
    const result = await check({ run: runs([ok({ exitCode: 3, stderr: 'deadline expired' })]) });

    expect(result.status).toBe('timeout');
    expect(result.stage).toBe('readiness');
    expect(recorder.ran).toHaveLength(1);
  });

  it('reports any other readiness failure as a failure, not as a timeout', async () => {
    const result = await check({ run: runs([ok({ exitCode: 1, stderr: 'probe crashed' })]) });

    expect(result.status).toBe('fail');
    expect(result.stage).toBe('readiness');
    expect(recorder.ran).toHaveLength(1);
  });

  it('names the readiness container per attempt, so it can be terminated by name', async () => {
    await check();

    expect(runtimeReadinessContainerName(ATTEMPT)).toBe('ai-harness-ready-attempt-1');
    expect(recorder.ran[0]?.spec.name).toBe(runtimeReadinessContainerName(ATTEMPT));
  });

  it('does not terminate the probe while the application is still running', async () => {
    await check();

    expect(recorder.events.some((event) => event.startsWith('terminate:'))).toBe(false);
  });
});

/**
 * The probe cannot see the application container — it has no Docker socket, only the network.
 * Waiting out a 60-second budget for a process that is already dead is the harness's job to
 * avoid, and only the host can observe that.
 */
describe('an application that exits before it is ready', () => {
  it('stops the probe as soon as the application is gone, and says so', async () => {
    const { probe, release } = heldProbe();

    const result = await check({
      isRunning: async () => false,
      terminate: async (name) => {
        recorder.events.push(`terminate:${name}`);
        release(ok({ exitCode: 137, stderr: 'terminated' }));
      },
      run: async (spec, options) => {
        recorder.ran.push({ spec, options });
        return recorder.ran.length === 1 ? probe : ok();
      },
    });

    expect(result.status).toBe('fail');
    expect(result.stage).toBe('readiness');
    expect(result.readiness.applicationExited).toBe(true);
    expect(result.reason).toMatch(/exited/i);

    // No behavioral command runs, and the readiness container was killed by name.
    expect(recorder.ran).toHaveLength(1);
    expect(result.commands).toEqual([]);
    expect(recorder.events).toContain(`terminate:${runtimeReadinessContainerName(ATTEMPT)}`);
  });

  it('keeps trying to stop the probe until the container it names exists', async () => {
    const { probe, release } = heldProbe();
    let attempts = 0;

    const result = await check({
      isRunning: async () => false,
      terminate: async () => {
        attempts += 1;
        // `docker run` creates its container asynchronously, so an early kill finds nothing
        // to kill and Docker reports that as success. One attempt is therefore not enough:
        // giving up after it leaves the probe polling a dead application for its whole budget.
        if (attempts >= 3) release(ok({ exitCode: 137 }));
      },
      run: async (spec, options) => {
        recorder.ran.push({ spec, options });
        return recorder.ran.length === 1 ? probe : ok();
      },
    });

    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(result.status).toBe('fail');
    expect(result.readiness.applicationExited).toBe(true);
  });

  it('still captures the application logs that explain why it exited', async () => {
    const { probe, release } = heldProbe();

    await check({
      isRunning: async () => false,
      terminate: async () => release(ok({ exitCode: 137 })),
      run: async (spec, options) => {
        recorder.ran.push({ spec, options });
        return recorder.ran.length === 1 ? probe : ok();
      },
      captureLogs: async () => ({ stdout: '', stderr: 'cannot bind: configuration missing\n' }),
    });

    expect(await readArtifact(APPLICATION_LOG_FILE)).toContain('cannot bind');
  });

  it('lets the deadline back it up when the probe cannot be terminated early', async () => {
    const { probe, release } = heldProbe();

    const result = await check({
      isRunning: async () => false,
      terminate: async () => {
        // The kill is an optimization; the container ladder is still the real deadline.
        release(ok({ exitCode: 137, status: 'timeout' }));
        throw new Error('kill refused');
      },
      run: async (spec, options) => {
        recorder.ran.push({ spec, options });
        return recorder.ran.length === 1 ? probe : ok();
      },
    });

    // The more specific fact wins the verdict; the probe's own outcome is still recorded.
    expect(result.status).toBe('fail');
    expect(result.stage).toBe('readiness');
    expect(result.readiness.applicationExited).toBe(true);
    expect(result.readiness.status).toBe('timeout');
  });

  /**
   * The watcher and the probe race by construction. A probe that already answered has settled
   * the question, so a liveness poll that lands afterwards must not overturn it.
   */
  it('does not overturn a readiness check the probe already passed', async () => {
    const result = await check({ isRunning: async () => false });

    expect(result.status).toBe('pass');
    expect(result.stage).toBeUndefined();
    expect(result.reason).toBeUndefined();
    expect(result.readiness.applicationExited).toBeUndefined();
    // Readiness passed, so the behavioral commands still run; if the application died after
    // answering, that is their failure to report, with the exit in application.log.
    expect(result.commands).toHaveLength(2);
  });

  it('records the reason in runtime.json', async () => {
    const { probe, release } = heldProbe();

    await check({
      isRunning: async () => false,
      terminate: async () => release(ok({ exitCode: 137 })),
      run: async (spec, options) => {
        recorder.ran.push({ spec, options });
        return recorder.ran.length === 1 ? probe : ok();
      },
    });

    const stored = JSON.parse(await readArtifact(RUNTIME_RESULT_FILE)) as RuntimeCheckResult;
    expect(stored.status).toBe('fail');
    expect(stored.reason).toMatch(/exited/i);
    expect(stored.readiness.applicationExited).toBe(true);
  });
});

describe('behavioral commands', () => {
  it('runs every declared command in order, with the application URL', async () => {
    const result = await check();

    expect(recorder.ran).toHaveLength(3);
    expect(recorder.ran.slice(1).map(({ spec }) => spec.argv)).toEqual(
      RUNTIME.behavioral_commands,
    );

    for (const { spec, options } of recorder.ran.slice(1)) {
      expect(spec.image).toBe(IMAGES.verifier.id);
      expect(spec.network).toBe(NETWORK);
      expect(spec.mounts).toEqual(MOUNTS.map((mount) => ({ ...mount, readonly: true })));
      expect(spec.env?.HARNESS_APP_URL).toBe(`http://${APP}:3000`);
      expect(options.timeoutSeconds).toBe(RUNTIME_COMMAND_TIMEOUT_SECONDS);
    }

    expect(result.status).toBe('pass');
    expect(result.stage).toBeUndefined();
    expect(result.commands.map((command) => command.exitCode)).toEqual([0, 0]);
  });

  it('stops at the first failing command', async () => {
    const result = await check({ run: runs([ok(), ok({ exitCode: 4 })]) });

    expect(result.status).toBe('fail');
    expect(result.stage).toBe('behavioral');
    expect(recorder.ran).toHaveLength(2);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.argv).toEqual(RUNTIME.behavioral_commands[0]);
  });

  it('stops at the first command that exceeds its budget', async () => {
    const result = await check({ run: runs([ok(), ok({ status: 'timeout', exitCode: 137 })]) });

    expect(result.status).toBe('timeout');
    expect(result.stage).toBe('behavioral');
    expect(recorder.ran).toHaveLength(2);
  });
});

describe('runtime evidence', () => {
  it('captures application logs before removing the container', async () => {
    await check();

    expect(recorder.events).toEqual([
      'start',
      'run:1',
      'run:2',
      'run:3',
      'logs',
      'remove',
    ]);
    expect(await readArtifact(APPLICATION_LOG_FILE)).toContain('listening on 0.0.0.0:3000');
  });

  it('records the verdict, the startup argv, the readiness target and the verifier image', async () => {
    const result = await check();
    const stored = JSON.parse(await readArtifact(RUNTIME_RESULT_FILE)) as RuntimeCheckResult;

    expect(stored.status).toBe('pass');
    expect(stored.startCommand).toEqual(['node', 'dist/server.js']);
    expect(stored.readinessUrl).toBe(`http://${APP}:3000/health`);
    expect(stored.readiness.durationMs).toBeGreaterThanOrEqual(0);
    expect(stored.verifierImage).toBe(IMAGES.verifier.id);
    expect(stored.commands).toHaveLength(2);
    expect(result.verifierImage).toBe(IMAGES.verifier.id);
  });

  it('writes evidence for a failed check too', async () => {
    await check({ run: runs([ok(), ok({ exitCode: 4, stderr: 'orders check failed' })]) });

    const stored = JSON.parse(await readArtifact(RUNTIME_RESULT_FILE)) as RuntimeCheckResult;
    expect(stored.status).toBe('fail');
    expect(stored.stage).toBe('behavioral');
    expect(await readArtifact(BEHAVIORAL_LOG_FILE)).toContain('orders check failed');
  });

  it('passes every stored byte through the redactor', async () => {
    await check({
      redact: (text) => text.split('sk-secret-value').join('[redacted]'),
      captureLogs: async () => ({ stdout: 'booted with sk-secret-value\n', stderr: '' }),
      run: runs([ok(), ok({ exitCode: 4, stdout: 'saw sk-secret-value' })]),
    });

    for (const file of [RUNTIME_RESULT_FILE, APPLICATION_LOG_FILE, BEHAVIORAL_LOG_FILE]) {
      expect(await readArtifact(file)).not.toContain('sk-secret-value');
    }
    expect(await readArtifact(APPLICATION_LOG_FILE)).toContain('[redacted]');
  });
});

describe('runtime infrastructure failures', () => {
  it('throws rather than returning a verdict when the application cannot start', async () => {
    const failure = await check({
      start: () => Promise.reject(new Error('no such image')),
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(RuntimeInfrastructureError);
    expect((failure as Error).message).toContain('no such image');
  });

  it('throws rather than returning a verdict when a container cannot be created', async () => {
    const failure = await check({
      run: () => Promise.reject(new Error('cannot create container')),
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(RuntimeInfrastructureError);
    expect((failure as Error).message).toContain('cannot create container');
  });

  it('throws when application logs cannot be captured', async () => {
    const failure = await check({
      captureLogs: () => Promise.reject(new Error('docker logs failed')),
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(RuntimeInfrastructureError);
    expect((failure as Error).message).toContain('docker logs failed');
  });

  it('throws when the evidence cannot be written', async () => {
    const blocked = join(dir, 'blocked');
    await writeFile(blocked, 'not a directory');

    const failure = await check({ artifactDir: blocked }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(RuntimeInfrastructureError);
  });

  it('removes the application container even when the run failed', async () => {
    await check({ run: () => Promise.reject(new Error('cannot create container')) }).catch(
      () => undefined,
    );

    expect(recorder.events).toContain('remove');
    expect(dockerCalls).toContainEqual(['network', 'rm', NETWORK]);
  });
});

describe('runtime cleanup failures', () => {
  it('surfaces a container-removal failure on the passing path', async () => {
    const failure = await check({
      removeContainer: () => Promise.reject(new Error('container removal refused')),
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(CleanupError);
    expect((failure as CleanupError).errors.join('\n')).toContain('container removal refused');
  });

  it('surfaces a network-removal failure on the passing path', async () => {
    dockerFailure.match = 'network rm';
    dockerFailure.stderr = 'network has active endpoints';

    const failure = await check().catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(CleanupError);
    expect((failure as CleanupError).errors.join('\n')).toContain('active endpoints');
  });

  it('never lets cleanup replace a verification failure', async () => {
    const result = await check({
      run: runs([ok(), ok({ exitCode: 4 })]),
      removeContainer: () => Promise.reject(new Error('container removal refused')),
    });

    expect(result.status).toBe('fail');
    expect(result.stage).toBe('behavioral');
    expect(result.cleanupError).toContain('container removal refused');
  });

  it('keeps a failing verdict when the network leaks with the container', async () => {
    // The realistic pair: a container that could not be removed is what still holds an
    // endpoint on the network, so the network cannot be removed either.
    dockerFailure.match = 'network rm';
    dockerFailure.stderr = 'network has active endpoints';

    const result = await check({
      run: runs([ok(), ok({ exitCode: 4 })]),
      removeContainer: () => Promise.reject(new Error('container removal refused')),
    });

    expect(result.status).toBe('fail');
    expect(result.stage).toBe('behavioral');
    expect(result.cleanupError).toContain('container removal refused');
    expect(result.cleanupError).toContain('active endpoints');
  });

  it('keeps an infrastructure failure primary when cleanup also fails', async () => {
    const failure = await check({
      run: () => Promise.reject(new Error('cannot create container')),
      removeContainer: () => Promise.reject(new Error('container removal refused')),
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(OwnershipError);
    expect(((failure as OwnershipError).cause as Error).message).toContain(
      'cannot create container',
    );
    expect((failure as Error).message).toContain('container removal refused');
  });
});
