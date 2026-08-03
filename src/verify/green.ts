import type { TestRunResults } from './results.js';

export interface GreenReason {
  category:
    | 'expected_test_missing'
    | 'expected_test_failed'
    | 'unexpected_skip'
    | 'baseline_regression'
    | 'runner_failed'
    | 'runner_did_not_complete';
  message: string;
}

export interface GreenVerdict {
  valid: boolean;
  reasons: GreenReason[];
}

export function classifyGreen(options: {
  baseline: TestRunResults;
  results: TestRunResults | undefined;
  expectedTestIds: readonly string[];
}): GreenVerdict {
  if (options.results === undefined) {
    return {
      valid: false,
      reasons: [
        {
          category: 'runner_did_not_complete',
          message: 'GREEN runner did not produce a results document',
        },
      ],
    };
  }

  const results = options.results;
  const reasons: GreenReason[] = [];

  for (const id of options.expectedTestIds) {
    const test = results.tests.get(id);
    if (test === undefined) {
      reasons.push({
        category: 'expected_test_missing',
        message: `expected test is missing at GREEN: ${id}`,
      });
    } else if (test.status === 'skipped' || test.status === 'todo') {
      reasons.push({
        category: 'unexpected_skip',
        message: `expected test is skipped at GREEN: ${id}`,
      });
    } else if (test.status !== 'passed') {
      reasons.push({
        category: 'expected_test_failed',
        message: `expected test failed at GREEN: ${id}`,
      });
    }
  }

  for (const baselineTest of options.baseline.tests.values()) {
    if (baselineTest.status !== 'passed') continue;

    const greenTest = results.tests.get(baselineTest.id);
    if (greenTest?.status !== 'passed') {
      reasons.push({
        category: 'baseline_regression',
        message: `baseline test no longer passes: ${baselineTest.id}`,
      });
    }
  }

  if (!results.success || results.exitCode !== 0) {
    reasons.push({
      category: 'runner_failed',
      message: `GREEN runner reported success=${String(results.success)} with exit code ${String(results.exitCode)}`,
    });
  }

  return { valid: reasons.length === 0, reasons };
}

export function greenResultsArtifact(results: TestRunResults): object {
  return {
    success: results.success,
    exitCode: results.exitCode,
    tests: [...results.tests.values()].map((test) => ({ ...test })),
    suiteFailures: results.suiteFailures,
  };
}
