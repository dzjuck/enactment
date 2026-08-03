import { describe, expect, it } from 'vitest';

import { evaluateBaselineRuns } from '../../src/verify/baseline.js';
import type { TestOutcome, TestRunResults } from '../../src/verify/results.js';

const policy = { retryFailures: 1, knownFlakyTests: [] as string[] };

function run(outcomes: TestOutcome[], success = outcomes.every((test) => test.status !== 'failed')): TestRunResults {
  return {
    success,
    exitCode: success ? 0 : 1,
    tests: new Map(outcomes.map((test) => [test.id, test])),
    suiteFailures: [],
  };
}

function outcome(id: string, status: TestOutcome['status']): TestOutcome {
  return { id, status, suitePath: 'test/existing.test.js' };
}

describe('baseline flake policy', () => {
  it('retries the first failure once and warns when it passes', () => {
    const failed = run([outcome('existing behavior works', 'failed')]);
    expect(evaluateBaselineRuns([failed], policy, []).status).toBe('retry');

    const verdict = evaluateBaselineRuns(
      [failed, run([outcome('existing behavior works', 'passed')])],
      policy,
      [],
    );
    expect(verdict.status).toBe('pass');
    expect(verdict.warnings).toContain('existing behavior works');
  });

  it('blocks when the retry also fails', () => {
    const failed = run([outcome('existing behavior works', 'failed')]);
    const verdict = evaluateBaselineRuns([failed, failed], policy, []);

    expect(verdict.status).toBe('fail');
    expect(verdict.failures).toContain('existing behavior works');
  });

  it('continues with a recorded quarantined failure', () => {
    const failed = run([outcome('known flaky behavior', 'failed')]);
    const verdict = evaluateBaselineRuns(
      [failed],
      { retryFailures: 1, knownFlakyTests: ['known flaky behavior'] },
      [],
    );

    expect(verdict.status).toBe('pass');
    expect(verdict.quarantined).toEqual(['known flaky behavior']);
  });

  it('does not retry a passing first run', () => {
    const verdict = evaluateBaselineRuns(
      [run([outcome('existing behavior works', 'passed')])],
      policy,
      [],
    );

    expect(verdict.status).toBe('pass');
    expect(verdict.warnings).toEqual([]);
  });
});
