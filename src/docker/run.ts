import { randomUUID } from 'node:crypto';

import { execa } from 'execa';

import { buildRunArgs, type ContainerSpec } from './args.js';

export type RunStatus = 'completed' | 'timeout';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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

  const child = execa('docker', buildRunArgs({ ...spec, name, interactive: options.input !== undefined }), {
    reject: false,
    ...(options.input === undefined ? {} : { input: options.input }),
  });

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

    return {
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
      status: timedOut ? 'timeout' : 'completed',
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // `--rm` normally suffices; this closes the paths where it does not.
    await docker(['rm', '--force', name]);
  }
}
