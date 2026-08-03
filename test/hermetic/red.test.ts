import { describe, expect, it } from 'vitest';

import { classifyRed } from '../../src/verify/red.js';
import type {
  SuiteFailure,
  TestOutcome,
  TestRunResults,
} from '../../src/verify/results.js';

const contract = {
  expectedTestIds: ['slugify lowercases and hyphenates words'],
  allowedRedCategories: [
    'assertion_failure',
    'missing_implementation',
    'expected_type_failure',
  ],
  implementationPaths: ['src/slugify.js'],
};

function outcome(
  id: string,
  status: TestOutcome['status'],
  suitePath = 'test/slugify.test.js',
): TestOutcome {
  return { id, status, suitePath };
}

function results(
  tests: TestOutcome[] = [],
  suiteFailures: SuiteFailure[] = [],
): TestRunResults {
  const success = tests.every((test) => test.status !== 'failed') && suiteFailures.length === 0;
  return {
    success,
    exitCode: success ? 0 : 1,
    tests: new Map(tests.map((test) => [test.id, test])),
    suiteFailures,
  };
}

const baseline = results([outcome('existing behavior already passes', 'passed')]);

describe('RED classification', () => {
  it('accepts a discovered failing expected test as assertion_failure', () => {
    const verdict = classifyRed({
      ...contract,
      baseline,
      results: results([
        outcome('slugify lowercases and hyphenates words', 'failed'),
      ]),
    });

    expect(verdict.valid).toBe(true);
    expect(verdict.category).toBe('assertion_failure');
    expect(verdict.reasons).toEqual([]);
  });

  it('accepts a missing implementation module without discovered test IDs', () => {
    const verdict = classifyRed({
      ...contract,
      baseline,
      results: results([], [
        {
          suitePath: 'test/slugify.test.js',
          cause: 'missing_module',
          specifier: '../src/slugify.js',
          message: "Cannot find module '../src/slugify.js' imported from test/slugify.test.js",
        },
      ]),
    });

    expect(verdict.valid).toBe(true);
    expect(verdict.category).toBe('missing_implementation');
  });

  it('rejects a missing bare package as unrelated_missing_dependency', () => {
    const verdict = classifyRed({
      ...contract,
      baseline,
      results: results([], [
        {
          suitePath: 'test/slugify.test.js',
          cause: 'missing_package',
          specifier: 'missing-package',
          message: "Cannot find package 'missing-package' imported from test/slugify.test.js",
        },
      ]),
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'unrelated_missing_dependency' }),
      ]),
    );
  });

  it('rejects a syntax collection failure as broken_test_file', () => {
    const verdict = classifyRed({
      ...contract,
      baseline,
      results: results([], [
        {
          suitePath: 'test/slugify.test.js',
          cause: 'syntax_error',
          message: 'Failed to parse source for import analysis because the content contains invalid JS syntax.',
        },
      ]),
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'broken_test_file' })]),
    );
  });

  it('rejects a missing relative module outside implementation_paths', () => {
    const verdict = classifyRed({
      ...contract,
      baseline,
      results: results([], [
        {
          suitePath: 'test/slugify.test.js',
          cause: 'missing_module',
          specifier: '../support/fixture.js',
          message: "Cannot find module '../support/fixture.js' imported from test/slugify.test.js",
        },
      ]),
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'missing_implementation_outside_scope' }),
      ]),
    );
  });

  it('rejects a valid category that the task did not allow', () => {
    const verdict = classifyRed({
      ...contract,
      allowedRedCategories: ['assertion_failure'],
      baseline,
      results: results([], [
        {
          suitePath: 'test/slugify.test.js',
          cause: 'missing_module',
          specifier: '../src/slugify.js',
          message: "Cannot find module '../src/slugify.js' imported from test/slugify.test.js",
        },
      ]),
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'category_not_allowed',
          message: expect.stringContaining('missing_implementation'),
        }),
      ]),
    );
    expect(verdict.reasons[0]?.message).toContain('assertion_failure');
  });

  it('rejects an expected test that passes at RED', () => {
    const verdict = classifyRed({
      ...contract,
      baseline,
      results: results([
        outcome('slugify lowercases and hyphenates words', 'passed'),
      ]),
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'expected_test_passing' })]),
    );
  });

  it('rejects a new failure in a test that passed at baseline', () => {
    const verdict = classifyRed({
      ...contract,
      baseline,
      results: results([
        outcome('existing behavior already passes', 'failed'),
        outcome('slugify lowercases and hyphenates words', 'failed'),
      ]),
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'unrelated_existing_failure',
          message: expect.stringContaining('existing behavior already passes'),
        }),
      ]),
    );
  });

  it('rejects a new skip as unexpected_skip', () => {
    const verdict = classifyRed({
      ...contract,
      baseline,
      results: results([
        outcome('existing behavior already passes', 'skipped'),
        outcome('slugify lowercases and hyphenates words', 'failed'),
      ]),
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'unexpected_skip',
          message: expect.stringContaining('existing behavior already passes'),
        }),
      ]),
    );
  });

  it('rejects a run with no results document', () => {
    const verdict = classifyRed({ ...contract, baseline, results: undefined });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual([
      expect.objectContaining({ category: 'runner_did_not_complete' }),
    ]);
  });

  it('reports every invalid reason', () => {
    const verdict = classifyRed({
      ...contract,
      baseline,
      results: results([
        outcome('existing behavior already passes', 'skipped'),
        outcome('slugify lowercases and hyphenates words', 'passed'),
      ], [
        {
          suitePath: 'test/broken.test.js',
          cause: 'syntax_error',
          message: 'Failed to parse source for import analysis because the content contains invalid JS syntax.',
        },
      ]),
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reasons.map((reason) => reason.category)).toEqual(
      expect.arrayContaining(['expected_test_passing', 'unexpected_skip', 'broken_test_file']),
    );
  });
});
