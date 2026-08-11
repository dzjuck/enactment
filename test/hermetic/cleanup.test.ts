import { describe, expect, it } from 'vitest';

import { releaseAll, withCleanupOutcome } from '../../src/run/cleanup.js';
import type { RunReport } from '../../src/run/orchestrator.js';

const SUCCEEDED: RunReport = {
  status: 'succeeded',
  attempt: 'attempt-1',
  commit: '0'.repeat(40),
  branch: 'enactment/slugify-plan',
};

const FAILED: RunReport = {
  status: 'failed',
  attempt: 'attempt-1',
  failedPhase: 'agent',
  category: 'agent_timeout',
  message: 'agent run timeout (exit -1)',
};

describe('releaseAll', () => {
  it('runs every step in reverse order, so resources unwind as they were acquired', async () => {
    const order: string[] = [];
    const step = (name: string) => async () => void order.push(name);

    const errors = await releaseAll([step('workspace'), step('deps'), step('run-home')]);

    expect(errors).toEqual([]);
    expect(order).toEqual(['run-home', 'deps', 'workspace']);
  });

  it('keeps releasing after one step fails, and reports every failure', async () => {
    const order: string[] = [];

    const errors = await releaseAll([
      async () => void order.push('workspace'),
      () => Promise.reject(new Error('volume still in use')),
      async () => void order.push('run-home'),
    ]);

    // A failure in the middle must not strand the resources acquired before it.
    expect(order).toEqual(['run-home', 'workspace']);
    expect(errors).toEqual(['volume still in use']);
  });

  it('collects failures from every step rather than only the first', async () => {
    const errors = await releaseAll([
      () => Promise.reject(new Error('network has active endpoints')),
      () => Promise.reject(new Error('volume still in use')),
    ]);

    expect(errors).toEqual(['volume still in use', 'network has active endpoints']);
  });
});

describe('withCleanupOutcome', () => {
  it('leaves a report untouched when cleanup succeeded', () => {
    expect(withCleanupOutcome(SUCCEEDED, [])).toEqual(SUCCEEDED);
    expect(withCleanupOutcome(FAILED, [])).toEqual(FAILED);
  });

  it('turns an otherwise successful run into a failure when cleanup failed', () => {
    const report = withCleanupOutcome(SUCCEEDED, ['network has active endpoints']);

    expect(report.status).toBe('failed');
    expect(report.category).toBe('internal_error');
    expect(report.message).toContain('network has active endpoints');
    expect(report.cleanupErrors).toEqual(['network has active endpoints']);

    // The commit was really made; suppressing that would be its own lie.
    expect(report.commit).toBe(SUCCEEDED.commit);
    expect(report.branch).toBe(SUCCEEDED.branch);
  });

  it('preserves the primary failure and adds the cleanup error alongside it', () => {
    const report = withCleanupOutcome(FAILED, ['volume still in use']);

    expect(report.status).toBe('failed');
    expect(report.failedPhase).toBe('agent');
    expect(report.category).toBe('agent_timeout');
    expect(report.message).toBe(FAILED.message);
    expect(report.cleanupErrors).toEqual(['volume still in use']);
  });

  it('never reports success while a resource is known to be leaked', () => {
    for (const errors of [['a'], ['a', 'b']]) {
      expect(withCleanupOutcome(SUCCEEDED, errors).status).toBe('failed');
      expect(withCleanupOutcome(FAILED, errors).status).toBe('failed');
    }
  });
});
