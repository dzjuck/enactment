import { setTimeout as delay } from 'node:timers/promises';

import { execa } from 'execa';

import { DEFAULT_TIMEOUTS } from '../task/schema.js';
import { PhaseFailure, type FailureCategory } from './failure.js';

export interface Timeouts {
  connectivity_smoke_seconds: number;
  /** The cold dependency install's budget; a warm cache never reaches it. */
  setup_seconds: number;
  agent_seconds: number;
  termination_grace_seconds: number;
}

/** DESIGN.md §27's container contract. A task may lower these; it may never raise them. */
export const CONTRACT_TIMEOUTS: Timeouts = { ...DEFAULT_TIMEOUTS };

export function resolveTimeouts(task: Partial<Timeouts> = {}): Timeouts {
  const lower = (key: keyof Timeouts): number =>
    Math.min(CONTRACT_TIMEOUTS[key], task[key] ?? Number.POSITIVE_INFINITY);

  return {
    connectivity_smoke_seconds: lower('connectivity_smoke_seconds'),
    setup_seconds: lower('setup_seconds'),
    agent_seconds: lower('agent_seconds'),
    termination_grace_seconds: lower('termination_grace_seconds'),
  };
}

export interface Killer {
  terminate(name: string): Promise<void>;
  kill(name: string): Promise<void>;
}

/** Signals the container directly: killing the `docker run` client would orphan it. */
export const dockerKiller: Killer = {
  terminate: async (name) => {
    await execa('docker', ['kill', '--signal', 'TERM', name], { reject: false });
  },
  kill: async (name) => {
    await execa('docker', ['kill', '--signal', 'KILL', name], { reject: false });
  },
};

export interface TimeoutLadderOptions<T> {
  name: string;
  work: Promise<T>;
  /** Absent means no deadline. */
  timeoutSeconds?: number;
  graceSeconds: number;
  killer?: Killer;
  sleep?: (ms: number) => Promise<void>;
}

export interface LadderOutcome<T> {
  value?: T;
  timedOut: boolean;
}

/**
 * SIGTERM → wait `graceSeconds` → SIGKILL (DESIGN.md §5).
 *
 * The provider CLI does not fail fast when it cannot reach the provider — it retries and
 * reconnects indefinitely — so the ladder is not a safety net around the failure path; it is
 * the failure path.
 */
export async function withTimeoutLadder<T>(
  options: TimeoutLadderOptions<T>,
): Promise<LadderOutcome<T>> {
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const killer = options.killer ?? dockerKiller;

  let outcome: { value: T } | undefined;
  let failure: { error: unknown } | undefined;
  const tracked = options.work.then(
    (value) => {
      outcome = { value };
    },
    (error: unknown) => {
      failure = { error };
    },
  );

  const settled = (): boolean => outcome !== undefined || failure !== undefined;

  if (options.timeoutSeconds === undefined) {
    await tracked;
    if (failure !== undefined) throw failure.error;
    return { ...outcome, timedOut: false };
  }

  const deadline = new AbortController();
  const expired = delay(options.timeoutSeconds * 1000, 'expired', { signal: deadline.signal }).catch(
    () => 'cancelled',
  );

  await Promise.race([tracked, expired]);

  if (settled()) {
    deadline.abort();
    if (failure !== undefined) throw failure.error;
    return { ...outcome, timedOut: false };
  }

  await killer.terminate(options.name);
  await Promise.race([tracked, sleep(options.graceSeconds * 1000)]);

  if (settled()) {
    if (failure !== undefined) throw failure.error;
    return { ...outcome, timedOut: true };
  }

  await killer.kill(options.name);
  return { timedOut: true };
}

export interface PhaseTimeoutOptions<T> extends TimeoutLadderOptions<T> {
  phase: string;
  category: FailureCategory;
  /** Restore the pre-invocation workspace snapshot before the failure is reported (§5). */
  onTimeout?: () => Promise<void>;
}

export async function withPhaseTimeout<T>(
  work: Promise<T>,
  options: Omit<PhaseTimeoutOptions<T>, 'work'>,
): Promise<T> {
  const result = await withTimeoutLadder({ ...options, work });

  if (result.timedOut) {
    await options.onTimeout?.();
    throw new PhaseFailure(
      options.phase,
      options.category,
      `${options.phase} exceeded ${String(options.timeoutSeconds)}s and was terminated`,
    );
  }

  return result.value as T;
}
