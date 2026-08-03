export type TestId = string;

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'todo';

export interface TestOutcome {
  readonly id: TestId;
  readonly suitePath: string;
  readonly status: TestStatus;
  readonly failureMessage?: string;
}

export type SuiteFailureCause =
  | 'missing_module'
  | 'missing_package'
  | 'syntax_error'
  | 'unknown';

export interface SuiteFailure {
  readonly suitePath: string;
  readonly cause: SuiteFailureCause;
  readonly message: string;
  readonly specifier?: string;
}

export interface TestRunResults {
  readonly success: boolean;
  readonly exitCode: number;
  readonly tests: ReadonlyMap<TestId, TestOutcome>;
  readonly suiteFailures: readonly SuiteFailure[];
}

export interface TestResultParserOptions {
  readonly artifactPath: string;
  readonly exitCode: number;
}

export interface TestResultParser {
  parse(document: string, options: TestResultParserOptions): TestRunResults;
}
