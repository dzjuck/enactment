import { posix } from 'node:path';

import picomatch from 'picomatch';

import type { TestRunResults } from './results.js';

export type ValidRedCategory = 'assertion_failure' | 'missing_implementation';

export interface RedReason {
  category:
    | 'unrelated_missing_dependency'
    | 'broken_test_file'
    | 'missing_implementation_outside_scope'
    | 'category_not_allowed'
    | 'expected_test_passing'
    | 'expected_tests_not_failed'
    | 'unrelated_existing_failure'
    | 'unexpected_skip'
    | 'runner_did_not_complete';
  message: string;
}

export interface RedVerdict {
  valid: boolean;
  category?: ValidRedCategory;
  reasons: RedReason[];
}

export interface RedContract {
  expectedTestIds: readonly string[];
  allowedRedCategories: readonly string[];
  implementationPaths: readonly string[];
}

function resolveMissingModule(suitePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;

  const resolved = posix.normalize(posix.join(posix.dirname(suitePath), specifier));
  if (resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) {
    return undefined;
  }
  return resolved;
}

export function classifyRed(
  options: RedContract & {
    baseline: TestRunResults;
    results: TestRunResults | undefined;
  },
): RedVerdict {
  if (options.results === undefined) {
    return {
      valid: false,
      reasons: [
        {
          category: 'runner_did_not_complete',
          message: 'RED runner did not produce a results document',
        },
      ],
    };
  }
  const results = options.results;

  const reasons: RedReason[] = [];
  const candidates = new Set<ValidRedCategory>();
  const implementationMatches = options.implementationPaths.map((pattern) =>
    picomatch(pattern, { dot: true }),
  );

  for (const failure of results.suiteFailures) {
    if (failure.cause === 'missing_module' && failure.specifier !== undefined) {
      const path = resolveMissingModule(failure.suitePath, failure.specifier);
      if (path !== undefined && implementationMatches.some((matches) => matches(path))) {
        candidates.add('missing_implementation');
      } else {
        reasons.push({
          category: 'missing_implementation_outside_scope',
          message: `missing module ${failure.specifier} does not resolve under implementation_paths`,
        });
      }
    } else if (failure.cause === 'missing_package') {
      reasons.push({
        category: 'unrelated_missing_dependency',
        message: `RED requires unrelated package ${failure.specifier ?? '(unknown)'}`,
      });
    } else if (failure.cause === 'syntax_error') {
      reasons.push({
        category: 'broken_test_file',
        message: `RED test file has invalid syntax: ${failure.suitePath}`,
      });
    } else {
      reasons.push({
        category: 'runner_did_not_complete',
        message: `RED suite did not complete: ${failure.suitePath}`,
      });
    }
  }

  const expected = options.expectedTestIds.map((id) => results.tests.get(id));
  const expectedPassing = expected.filter((test) => test?.status === 'passed');
  for (const test of expectedPassing) {
    reasons.push({
      category: 'expected_test_passing',
      message: `expected test already passes at RED: ${test?.id ?? '(unknown)'}`,
    });
  }

  if (expected.every((test) => test?.status === 'failed')) {
    candidates.add('assertion_failure');
  } else if (!candidates.has('missing_implementation') && expectedPassing.length === 0) {
    reasons.push({
      category: 'expected_tests_not_failed',
      message: 'expected tests were not all discovered and failing',
    });
  }

  for (const baselineTest of options.baseline.tests.values()) {
    const redTest = results.tests.get(baselineTest.id);
    if (baselineTest.status === 'passed' && redTest?.status === 'failed') {
      reasons.push({
        category: 'unrelated_existing_failure',
        message: `baseline test now fails: ${baselineTest.id}`,
      });
    }
    if (baselineTest.status !== 'skipped' && redTest?.status === 'skipped') {
      reasons.push({
        category: 'unexpected_skip',
        message: `baseline test is now skipped: ${baselineTest.id}`,
      });
    }
  }

  const category = candidates.values().next().value as ValidRedCategory | undefined;
  if (category !== undefined && !options.allowedRedCategories.includes(category)) {
    reasons.push({
      category: 'category_not_allowed',
      message: `RED category ${category} is not allowed; allowed: ${options.allowedRedCategories.join(', ')}`,
    });
  }

  if (category === undefined && reasons.length === 0) {
    reasons.push({
      category: 'expected_tests_not_failed',
      message: 'RED did not establish an approved failure category',
    });
  }

  return {
    valid: reasons.length === 0 && category !== undefined,
    ...(category === undefined ? {} : { category }),
    reasons,
  };
}

export function redResultsArtifact(results: TestRunResults): object {
  return {
    success: results.success,
    exitCode: results.exitCode,
    tests: [...results.tests.values()].map((test) => ({ ...test })),
    suiteFailures: results.suiteFailures,
  };
}
