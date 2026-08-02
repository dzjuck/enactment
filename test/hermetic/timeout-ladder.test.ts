import { describe, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORIES, PhaseFailure } from '../../src/run/failure.js';
import {
  CONTRACT_TIMEOUTS,
  resolveTimeouts,
  withPhaseTimeout,
  withTimeoutLadder,
  type Killer,
} from '../../src/run/timeout.js';

/** Records the ladder's steps in order, so "SIGTERM then SIGKILL" is an assertion. */
function recordingKiller(): { killer: Killer; steps: string[] } {
  const steps: string[] = [];

  return {
    steps,
    killer: {
      terminate: async (name) => {
        steps.push(`SIGTERM ${name}`);
      },
      kill: async (name) => {
        steps.push(`SIGKILL ${name}`);
      },
    },
  };
}

const never = (): Promise<never> => new Promise<never>(() => {});

describe('timeout configuration', () => {
  it('matches the §27 contract', () => {
    expect(CONTRACT_TIMEOUTS).toEqual({
      connectivity_smoke_seconds: 60,
      setup_seconds: 600,
      agent_seconds: 1200,
      termination_grace_seconds: 10,
    });
  });

  it('lets a task lower a timeout but never raise it', () => {
    expect(resolveTimeouts({ agent_seconds: 300 }).agent_seconds).toBe(300);
    expect(resolveTimeouts({ agent_seconds: 99_999 }).agent_seconds).toBe(1200);
    expect(resolveTimeouts({ connectivity_smoke_seconds: 600 }).connectivity_smoke_seconds).toBe(60);
    expect(resolveTimeouts().agent_seconds).toBe(CONTRACT_TIMEOUTS.agent_seconds);
  });

  it('defaults setup_seconds to 600 and lets a task lower but not raise it', () => {
    expect(resolveTimeouts().setup_seconds).toBe(600);
    expect(resolveTimeouts({ setup_seconds: 120 }).setup_seconds).toBe(120);
    expect(resolveTimeouts({ setup_seconds: 99_999 }).setup_seconds).toBe(600);
  });
});

describe('termination ladder', () => {
  it('escalates SIGTERM, grace, then SIGKILL, in that order', async () => {
    const { killer, steps } = recordingKiller();
    const sleep = vi.fn(async () => {
      steps.push('grace');
    });

    const result = await withTimeoutLadder({
      name: 'harness-hang',
      work: never(),
      timeoutSeconds: 0.01,
      graceSeconds: 10,
      killer,
      sleep,
    });

    expect(result.timedOut).toBe(true);
    expect(steps).toEqual(['SIGTERM harness-hang', 'grace', 'SIGKILL harness-hang']);
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it('never SIGKILLs work that exits during the grace period', async () => {
    const { killer, steps } = recordingKiller();
    let release: (value: string) => void = () => {};
    const work = new Promise<string>((resolve) => {
      release = resolve;
    });

    const result = await withTimeoutLadder({
      name: 'harness-polite',
      work,
      timeoutSeconds: 0.01,
      graceSeconds: 10,
      killer,
      sleep: async () => {
        release('exited politely');
      },
    });

    expect(result.value).toBe('exited politely');
    expect(steps).toEqual(['SIGTERM harness-polite']);
    expect(steps).not.toContain('SIGKILL harness-polite');
  });

  it('does not touch work that finishes before the timeout', async () => {
    const { killer, steps } = recordingKiller();

    const result = await withTimeoutLadder({
      name: 'harness-quick',
      work: Promise.resolve(42),
      timeoutSeconds: 60,
      graceSeconds: 10,
      killer,
    });

    expect(result).toEqual({ value: 42, timedOut: false });
    expect(steps).toEqual([]);
  });
});

describe('timeout classification', () => {
  it('reports a smoke-test timeout as provider_connectivity_timeout', async () => {
    const { killer } = recordingKiller();

    const failure = await withPhaseTimeout(never(), {
      name: 'harness-smoke',
      phase: 'connectivity',
      category: 'provider_connectivity_timeout',
      timeoutSeconds: 0.01,
      graceSeconds: 0,
      killer,
      sleep: async () => {},
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(PhaseFailure);
    expect((failure as PhaseFailure).category).toBe('provider_connectivity_timeout');
  });

  it('keeps a setup timeout distinct from a completed non-zero install', () => {
    expect(FAILURE_CATEGORIES).toContain('setup_timeout');
    expect(FAILURE_CATEGORIES).toContain('setup_failed');
  });

  it('keeps that category distinct from a generic agent failure and a non-zero exit', () => {
    expect(FAILURE_CATEGORIES).toContain('provider_connectivity_timeout');
    expect(FAILURE_CATEGORIES).toContain('agent_timeout');
    expect(FAILURE_CATEGORIES).toContain('agent_failed');
    expect(new Set(FAILURE_CATEGORIES).size).toBe(FAILURE_CATEGORIES.length);
  });

  it('restores the pre-invocation workspace before reporting the timeout', async () => {
    const { killer } = recordingKiller();
    const order: string[] = [];

    await withPhaseTimeout(never(), {
      name: 'harness-restore',
      phase: 'agent',
      category: 'agent_timeout',
      timeoutSeconds: 0.01,
      graceSeconds: 0,
      killer,
      sleep: async () => {},
      onTimeout: async () => {
        order.push('restored');
      },
    }).catch(() => order.push('reported'));

    expect(order).toEqual(['restored', 'reported']);
  });
});
