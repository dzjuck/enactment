import type { TestRunResults } from './results.js';

export interface BaselinePolicy {
  retryFailures: number;
  knownFlakyTests: readonly string[];
}

export interface BaselineVerdict {
  status: 'retry' | 'pass' | 'fail';
  warnings: string[];
  quarantined: string[];
  failures: string[];
}

export interface BaselineCapture extends Omit<BaselineVerdict, 'status'> {
  status: 'pass' | 'fail';
  attempts: number;
  results: TestRunResults;
}

export interface BaselineArtifact {
  status: 'pass' | 'fail';
  attempts: number;
  warnings: string[];
  quarantined: string[];
  failures: string[];
  success: boolean;
  exitCode: number;
  tests: {
    id: string;
    suitePath: string;
    status: string;
    failureMessage?: string;
  }[];
  suiteFailures: TestRunResults['suiteFailures'];
}

function failedTestIds(results: TestRunResults): string[] {
  return [...results.tests.values()]
    .filter((test) => test.status === 'failed')
    .map((test) => test.id);
}

export function evaluateBaselineRuns(
  runs: readonly TestRunResults[],
  policy: BaselinePolicy,
  expectedTestIds: readonly string[],
): BaselineVerdict {
  const latest = runs.at(-1);
  if (latest === undefined) {
    throw new Error('baseline evaluation needs at least one run');
  }

  const expectedPresent = expectedTestIds.filter((id) => latest.tests.has(id));
  if (expectedPresent.length > 0) {
    return {
      status: 'fail',
      warnings: [],
      quarantined: [],
      failures: expectedPresent.map((id) => `expected test already exists: ${id}`),
    };
  }

  const failedIds = failedTestIds(latest);
  const known = new Set(policy.knownFlakyTests);
  const quarantined = failedIds.filter((id) => known.has(id));
  const failures = failedIds.filter((id) => !known.has(id));
  failures.push(
    ...latest.suiteFailures.map((failure) => `${failure.suitePath}: ${failure.message}`),
  );

  if (
    (!latest.success || latest.exitCode !== 0) &&
    failedIds.length === 0 &&
    latest.suiteFailures.length === 0
  ) {
    failures.push(`test runner failed with exit code ${String(latest.exitCode)}`);
  }

  const warnings = [
    ...new Set(
      runs
        .slice(0, -1)
        .flatMap(failedTestIds)
        .filter((id) => latest.tests.get(id)?.status === 'passed'),
    ),
  ];

  if (failures.length === 0) {
    return { status: 'pass', warnings, quarantined, failures: [] };
  }
  if (runs.length <= policy.retryFailures) {
    return { status: 'retry', warnings, quarantined, failures };
  }
  return { status: 'fail', warnings, quarantined, failures };
}

export async function captureBaseline(options: {
  policy: BaselinePolicy;
  expectedTestIds: readonly string[];
  run: (attempt: number) => Promise<TestRunResults>;
}): Promise<BaselineCapture> {
  const runs: TestRunResults[] = [];
  while (true) {
    runs.push(await options.run(runs.length + 1));
    const verdict = evaluateBaselineRuns(runs, options.policy, options.expectedTestIds);
    if (verdict.status === 'retry') {
      continue;
    }
    const results = runs.at(-1);
    if (results === undefined) {
      throw new Error('baseline capture produced no results');
    }
    return {
      status: verdict.status,
      warnings: verdict.warnings,
      quarantined: verdict.quarantined,
      failures: verdict.failures,
      attempts: runs.length,
      results,
    };
  }
}

export function baselineArtifact(capture: BaselineCapture): BaselineArtifact {
  return {
    status: capture.status,
    attempts: capture.attempts,
    warnings: capture.warnings,
    quarantined: capture.quarantined,
    failures: capture.failures,
    success: capture.results.success,
    exitCode: capture.results.exitCode,
    tests: [...capture.results.tests.values()].map((test) => ({ ...test })),
    suiteFailures: capture.results.suiteFailures,
  };
}
