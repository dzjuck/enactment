import { describe, expect, it } from 'vitest';

import type { PlanProgress, PlanReport } from '../../src/run/coordinator.js';
import { createProgressWriter } from '../../src/run/progress.js';

function report(overrides: Partial<PlanReport> = {}): PlanReport {
  return {
    plan: 'task-summary',
    state: 'completed',
    branch: 'enactment/task-summary',
    baseCommit: '4f2a1c9876543210',
    head: 'c91ee40123456789',
    steps: [
      { id: 'summarize-tasks', status: 'completed', attempts: [], commit: '8b3d0f1123456789' },
      { id: 'summary-endpoint', status: 'completed', attempts: [], commit: 'c91ee40123456789' },
    ],
    ...overrides,
  };
}

function harness(start = 0): {
  output: () => string;
  event: (event: PlanProgress) => void;
  finish: (value?: PlanReport) => void;
  advance: (milliseconds: number) => void;
} {
  let current = start;
  let output = '';
  const writer = createProgressWriter({
    write: (text) => {
      output += text;
    },
    now: () => current,
  });

  return {
    output: () => output,
    event: writer.event,
    finish: writer.finish,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

const plan: PlanProgress = {
  kind: 'plan',
  planId: 'task-summary',
  steps: 2,
  repoPath: '/tmp/enactment-demo-a1b2c3',
  baseBranch: 'main',
  baseCommit: '4f2a1c9876543210',
  branch: 'enactment/task-summary',
  artifactsRoot: 'artifacts/task-summary',
};

describe('progress writer', () => {
  it('renders the plan header and a blank line', () => {
    const progress = harness();

    progress.event(plan);

    expect(progress.output()).toBe(
      'plan     task-summary\n' +
        'repo     /tmp/enactment-demo-a1b2c3\n' +
        'base     main 4f2a1c9\n' +
        'branch   enactment/task-summary\n\n',
    );
  });

  it('renders normal and stronger step headers', () => {
    const progress = harness();

    progress.event({
      kind: 'step',
      index: 1,
      total: 2,
      stepId: 'summarize-tasks',
      stepType: 'code_behavior',
      attempt: 'normal',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'medium',
    });
    progress.event({
      kind: 'step',
      index: 1,
      total: 2,
      stepId: 'summarize-tasks',
      stepType: 'code_behavior',
      attempt: 'stronger',
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
    });

    expect(progress.output()).toBe(
      '[1/2] summarize-tasks  code_behavior  codex gpt-5.6-luna/medium\n' +
        '[1/2] summarize-tasks  retry  claude claude-opus-5/high\n',
    );
  });

  it('opens a phase and closes it when the next phase starts', () => {
    const progress = harness();

    progress.event({ kind: 'phase', name: 'preparing' });
    expect(progress.output()).toBe('      preparing');

    progress.advance(6_000);
    progress.event({ kind: 'phase', name: 'baseline' });

    expect(progress.output()).toBe('      preparing 6s\n      baseline');
  });

  it('closes the phase and renders a committed short SHA', () => {
    const progress = harness();

    progress.event({ kind: 'phase', name: 'review' });
    progress.advance(11_000);
    progress.event({
      kind: 'stepDone',
      status: 'committed',
      commit: '8b3d0f1123456789',
    });

    expect(progress.output()).toBe('      review 11s\n      committed 8b3d0f1\n\n');
  });

  it('closes the phase and renders a failed outcome with evidence', () => {
    const progress = harness();

    progress.event({ kind: 'phase', name: 'red' });
    progress.advance(6_000);
    progress.event({
      kind: 'stepDone',
      status: 'failed',
      category: 'red_invalid',
      message: 'expected tests were not all discovered and failing',
      evidence: 'artifacts/task-summary/steps/summarize-tasks/att-7f3a/run-1',
    });

    expect(progress.output()).toBe(
      '      red 6s\n' +
        '      FAILED red_invalid: expected tests were not all discovered and failing\n' +
        '      evidence artifacts/task-summary/steps/summarize-tasks/att-7f3a/run-1\n',
    );
  });

  it('renders the completed summary from the report, branch head, and artifacts', () => {
    const progress = harness();

    progress.event(plan);
    progress.advance(318_000);
    progress.finish(report());

    expect(progress.output()).toContain(
      'completed  2 steps  2 commits  5m18s\n' +
        'branch     enactment/task-summary  c91ee40\n' +
        'artifacts  artifacts/task-summary\n',
    );
  });

  it('closes an open phase before finishing', () => {
    const progress = harness();

    progress.event(plan);
    progress.event({ kind: 'phase', name: 'final' });
    progress.advance(9_000);
    progress.finish(report());

    expect(progress.output()).toContain(
      '      final 9s\ncompleted  2 steps  0 commits  9s\n',
    );
  });

  it.each([
    {
      name: 'failed',
      value: report({ state: 'failed', failure: { message: 'cleanup failed' } }),
      expected: 'failed     cleanup failed\n',
    },
    {
      name: 'cancelled',
      value: report({ state: 'cancelled', failure: { message: 'operator cancelled the plan' } }),
      expected: 'cancelled  operator cancelled the plan\n',
    },
    {
      name: 'missing report',
      value: undefined,
      expected: 'failed     run did not return a report\n',
    },
  ])('renders one closing line for $name', ({ value, expected }) => {
    const progress = harness();

    progress.finish(value);

    expect(progress.output()).toBe(expected);
  });

  it('formats durations below and above one minute', () => {
    const progress = harness();

    progress.event({ kind: 'phase', name: 'short' });
    progress.advance(6_000);
    progress.event({ kind: 'phase', name: 'long' });
    progress.advance(318_000);
    progress.finish();

    expect(progress.output()).toBe(
      '      short 6s\n      long 5m18s\nfailed     run did not return a report\n',
    );
  });

  it('closes diagnosis before a stronger retry and emits no ANSI escapes', () => {
    const progress = harness();

    progress.event({ kind: 'phase', name: 'diagnosis' });
    progress.advance(22_000);
    progress.event({
      kind: 'step',
      index: 1,
      total: 2,
      stepId: 'summarize-tasks',
      stepType: 'code_behavior',
      attempt: 'stronger',
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
    });

    expect(progress.output()).toBe(
      '      diagnosis 22s\n[1/2] summarize-tasks  retry  claude claude-opus-5/high\n',
    );
    expect(progress.output()).not.toContain('\u001b');
  });
});
