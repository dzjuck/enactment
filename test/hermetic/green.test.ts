import { describe, expect, it } from 'vitest';

import { classifyGreen } from '../../src/verify/green.js';
import type { TestOutcome, TestRunResults } from '../../src/verify/results.js';

const expectedId = 'slugify lowercases and hyphenates words';

function outcome(id: string, status: TestOutcome['status']): TestOutcome {
  return { id, status, suitePath: 'test/slugify.test.js' };
}

function results(
  tests: TestOutcome[],
  options: { success?: boolean; exitCode?: number } = {},
): TestRunResults {
  return {
    success: options.success ?? tests.every((test) => test.status !== 'failed'),
    exitCode: options.exitCode ?? 0,
    tests: new Map(tests.map((test) => [test.id, test])),
    suiteFailures: [],
  };
}

const baseline = results([outcome('existing behavior already passes', 'passed')]);

describe('GREEN classification', () => {
  it('requires every expected ID to be present and passing', () => {
    const verdict = classifyGreen({
      baseline,
      results: results([
        outcome('existing behavior already passes', 'passed'),
        outcome(expectedId, 'passed'),
      ]),
      expectedTestIds: [expectedId],
    });

    expect(verdict).toEqual({ valid: true, reasons: [] });
  });

  it('rejects and names a missing expected ID', () => {
    const verdict = classifyGreen({
      baseline,
      results: results([outcome('existing behavior already passes', 'passed')]),
      expectedTestIds: [expectedId],
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'expected_test_missing',
          message: expect.stringContaining(expectedId),
        }),
      ]),
    );
  });

  it('rejects and names a baseline test that now fails', () => {
    const verdict = classifyGreen({
      baseline,
      results: results([
        outcome('existing behavior already passes', 'failed'),
        outcome(expectedId, 'passed'),
      ]),
      expectedTestIds: [expectedId],
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'baseline_regression',
          message: expect.stringContaining('existing behavior already passes'),
        }),
      ]),
    );
  });

  it('rejects a newly skipped expected test', () => {
    const verdict = classifyGreen({
      baseline,
      results: results([
        outcome('existing behavior already passes', 'passed'),
        outcome(expectedId, 'skipped'),
      ]),
      expectedTestIds: [expectedId],
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'unexpected_skip' }),
      ]),
    );
  });

  it('rejects success false even with exit code zero', () => {
    const verdict = classifyGreen({
      baseline,
      results: results(
        [outcome('existing behavior already passes', 'passed'), outcome(expectedId, 'passed')],
        { success: false, exitCode: 0 },
      ),
      expectedTestIds: [expectedId],
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'runner_failed' })]),
    );
  });

  it('rejects a non-zero exit even when every test reports passing', () => {
    const verdict = classifyGreen({
      baseline,
      results: results(
        [outcome('existing behavior already passes', 'passed'), outcome(expectedId, 'passed')],
        { success: true, exitCode: 1 },
      ),
      expectedTestIds: [expectedId],
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'runner_failed' })]),
    );
  });
});
