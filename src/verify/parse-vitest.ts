import { posix } from 'node:path';

import { z } from 'zod';

import type {
  SuiteFailure,
  TestOutcome,
  TestResultParser,
  TestResultParserOptions,
  TestRunResults,
} from './results.js';

const assertionSchema = z.object({
  fullName: z.string().min(1),
  status: z.enum(['passed', 'failed', 'skipped', 'todo']),
  failureMessages: z.array(z.string()),
});

const suiteSchema = z.object({
  assertionResults: z.array(assertionSchema),
  status: z.enum(['passed', 'failed']),
  message: z.string(),
  name: z.string().min(1),
});

const reportSchema = z.object({
  success: z.boolean(),
  testResults: z.array(suiteSchema),
});

export class TestResultParseError extends Error {
  readonly artifactPath: string;

  constructor(message: string, artifactPath: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'TestResultParseError';
    this.artifactPath = artifactPath;
  }
}

function workspaceRelativePath(path: string): string {
  if (!posix.isAbsolute(path)) return posix.normalize(path);

  const relativePath = posix.relative('/workspace', posix.normalize(path));
  return relativePath === '..' || relativePath.startsWith('../') ? path : relativePath;
}

function classifySuiteFailure(suitePath: string, message: string): SuiteFailure {
  const missingModule = /^Cannot find module '([^']+)' imported from/.exec(message);
  if (missingModule?.[1] !== undefined) {
    return {
      suitePath,
      cause: 'missing_module',
      specifier: missingModule[1],
      message,
    };
  }

  const missingPackage = /^Cannot find package '([^']+)' imported from/.exec(message);
  if (missingPackage?.[1] !== undefined) {
    return {
      suitePath,
      cause: 'missing_package',
      specifier: missingPackage[1],
      message,
    };
  }

  if (
    message.startsWith(
      'Failed to parse source for import analysis because the content contains invalid JS syntax.',
    )
  ) {
    return { suitePath, cause: 'syntax_error', message };
  }

  return { suitePath, cause: 'unknown', message };
}

export const vitestJsonParser: TestResultParser = {
  parse(document, options) {
    return parseVitestJson(document, options);
  },
};

export function parseVitestJson(
  document: string,
  options: TestResultParserOptions,
): TestRunResults {
  let json: unknown;
  try {
    json = JSON.parse(document);
  } catch (error) {
    throw new TestResultParseError(
      `Invalid JSON in test result artifact ${options.artifactPath}`,
      options.artifactPath,
      error,
    );
  }

  const parsed = reportSchema.safeParse(json);
  if (!parsed.success) {
    throw new TestResultParseError(
      `Invalid Vitest result artifact ${options.artifactPath}: ${parsed.error.message}`,
      options.artifactPath,
    );
  }

  const tests = new Map<string, TestOutcome>();
  const suiteFailures: SuiteFailure[] = [];

  for (const suite of parsed.data.testResults) {
    const suitePath = workspaceRelativePath(suite.name);

    for (const assertion of suite.assertionResults) {
      const firstFailure = assertion.failureMessages[0];
      tests.set(assertion.fullName, {
        id: assertion.fullName,
        suitePath,
        status: assertion.status,
        ...(firstFailure === undefined ? {} : { failureMessage: firstFailure }),
      });
    }

    if (suite.status === 'failed' && suite.assertionResults.length === 0) {
      suiteFailures.push(classifySuiteFailure(suitePath, suite.message));
    }
  }

  return {
    success: parsed.data.success,
    exitCode: options.exitCode,
    tests,
    suiteFailures,
  };
}
