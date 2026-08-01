import { randomUUID } from 'node:crypto';

import { execa } from 'execa';

import { buildRunArgs, type ContainerSpec } from './args.js';

export type RunStatus = 'completed' | 'timeout';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Raw stdout, for commands whose output is binary (a tar stream, say). */
  stdoutBytes: Buffer;
  durationMs: number;
  status: RunStatus;
}

export interface RunOptions {
  timeoutSeconds?: number;
  /** SIGTERM, then this long, then SIGKILL. DESIGN.md §5. */
  graceSeconds?: number;
  /** Written to the container's stdin, which is opened only when this is present. */
  input?: Buffer;
}

export const DEFAULT_GRACE_SECONDS = 10;

/**
 * Start a container in the background under the same hardening as `runContainer`, for
 * services that must outlive a single command. Returns its name.
 */
export async function startContainer(spec: ContainerSpec): Promise<string> {
  const name = spec.name ?? `harness-${randomUUID()}`;
  await execa('docker', buildRunArgs({ ...spec, name, detach: true }));
  return name;
}

export async function stopContainer(name: string): Promise<void> {
  await docker(['rm', '--force', name]);
}

export async function containerLogs(name: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execa('docker', ['logs', name], { reject: false });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function docker(args: string[]): Promise<void> {
  await execa('docker', args, { reject: false });
}

/**
 * Run a fixed command array in a hardened container. The container is named so that a timeout
 * can terminate it directly: killing the `docker run` client would leave the container alive.
 */
export async function runContainer(
  spec: ContainerSpec,
  options: RunOptions = {},
): Promise<RunResult> {
  const name = spec.name ?? `harness-${randomUUID()}`;
  const grace = options.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  const started = Date.now();

  const child = execa(
    'docker',
    buildRunArgs({ ...spec, name, interactive: options.input !== undefined }),
    {
      reject: false,
      // Always capture bytes; text is derived. Decoding a tar stream would corrupt it.
      encoding: 'buffer',
      ...(options.input === undefined ? {} : { input: options.input }),
    },
  );

  let timedOut = false;
  const timer =
    options.timeoutSeconds === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          void docker(['stop', '--timeout', String(grace), name]);
        }, options.timeoutSeconds * 1000);

  try {
    const result = await child;
    const stdoutBytes = Buffer.from(result.stdout ?? []);

    return {
      exitCode: result.exitCode ?? -1,
      stdout: stdoutBytes.toString('utf8'),
      stderr: Buffer.from(result.stderr ?? []).toString('utf8'),
      stdoutBytes,
      durationMs: Date.now() - started,
      status: timedOut ? 'timeout' : 'completed',
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // `--rm` normally suffices; this closes the paths where it does not.
    await docker(['rm', '--force', name]);
  }
}
