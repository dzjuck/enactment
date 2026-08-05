import { randomUUID } from 'node:crypto';

import { execa } from 'execa';

import { withTimeoutLadder } from '../run/timeout.js';
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

export class ContainerRemovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerRemovalError';
  }
}

/**
 * Remove a retained container, loudly.
 *
 * `stopContainer` is deliberately tolerant: it is a belt-and-braces call after `--rm` has
 * already done the work, so a failure there says nothing. A container started with
 * `autoRemove: false` has no such safety net — it exists until this call removes it, so a
 * failure here is a real leak and is reported as one. A container that is already gone is the
 * idempotent case and is success.
 */
export async function removeContainer(name: string): Promise<void> {
  try {
    await execa('docker', ['rm', '--force', name]);
  } catch (error) {
    const detail = error instanceof Error ? `${errorOutput(error)}${error.message}` : String(error);
    if (/no such container/i.test(detail)) return;

    throw new ContainerRemovalError(`failed to remove container ${name}: ${detail.trim()}`);
  }
}

function errorOutput(error: Error): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' && stderr !== '' ? `${stderr}\n` : '';
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
      // execa strips a final newline by default, which would make captured output a near-copy
      // rather than a copy. The credential copy-back claims to be byte-identical, so it has to
      // be: a file that legitimately ends in a newline must come back with it.
      stripFinalNewline: false,
      ...(options.input === undefined ? {} : { input: options.input }),
    },
  );

  try {
    // The §5 ladder, not a second implementation of it.
    const ladder = await withTimeoutLadder({
      name,
      work: child,
      graceSeconds: grace,
      ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
    });

    // Settles promptly either way: on the timeout path the container is already gone.
    const result = await child;
    const stdoutBytes = Buffer.from(result.stdout ?? []);

    return {
      exitCode: result.exitCode ?? -1,
      stdout: stdoutBytes.toString('utf8'),
      stderr: Buffer.from(result.stderr ?? []).toString('utf8'),
      stdoutBytes,
      durationMs: Date.now() - started,
      status: ladder.timedOut ? 'timeout' : 'completed',
    };
  } finally {
    // `--rm` normally suffices; this closes the paths where it does not.
    await docker(['rm', '--force', name]);
  }
}
