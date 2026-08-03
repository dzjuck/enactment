import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TestResultParseError, parseVitestJson } from '../../src/verify/parse-vitest.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../fixtures/test-results/${name}`, import.meta.url));

async function parseFixture(name: string, exitCode = 0) {
  return parseVitestJson(await readFile(fixture(name), 'utf8'), {
    artifactPath: name,
    exitCode,
  });
}

describe('parseVitestJson', () => {
  it('indexes passing tests by fullName and makes suite paths workspace-relative', async () => {
    const results = await parseFixture('passing.json');

    expect(results.tests.get('slugify lowercases and hyphenates')).toEqual({
      id: 'slugify lowercases and hyphenates',
      suitePath: 'test/slugify.test.js',
      status: 'passed',
    });
  });

  it('captures the first assertion failure message', async () => {
    const results = await parseFixture('assertion-failure.json', 1);

    expect(results.tests.get('slugify lowercases and hyphenates')).toEqual({
      id: 'slugify lowercases and hyphenates',
      suitePath: 'test/slugify.test.js',
      status: 'failed',
      failureMessage: 'expected \'Hello World\' to be \'hello-world\'',
    });
  });

  it('keeps skipped and todo outcomes distinct', async () => {
    const results = await parseFixture('skip-todo.json');

    expect(results.tests.get('slugify skips unsupported input')?.status).toBe('skipped');
    expect(results.tests.get('slugify supports unicode')?.status).toBe('todo');
  });

  it('classifies a missing relative module and preserves its specifier', async () => {
    const results = await parseFixture('missing-module.json', 1);

    expect(results.suiteFailures).toEqual([
      {
        suitePath: 'test/slugify.test.js',
        cause: 'missing_module',
        specifier: '../src/slugify.js',
        message:
          "Cannot find module '../src/slugify.js' imported from '/workspace/test/slugify.test.js'",
      },
    ]);
  });

  it('classifies a missing bare package separately', async () => {
    const results = await parseFixture('missing-package.json', 1);

    expect(results.suiteFailures[0]).toMatchObject({
      suitePath: 'test/slugify.test.js',
      cause: 'missing_package',
      specifier: 'missing-package',
    });
  });

  it('classifies syntax-error collection failures separately', async () => {
    const results = await parseFixture('syntax-error.json', 1);

    expect(results.suiteFailures[0]).toMatchObject({
      suitePath: 'test/slugify.test.js',
      cause: 'syntax_error',
    });
  });

  it('carries reporter success and process exit code', async () => {
    const results = await parseFixture('passing.json', 7);

    expect(results.success).toBe(true);
    expect(results.exitCode).toBe(7);
  });

  it('names the artifact when JSON is malformed', () => {
    expect(() =>
      parseVitestJson('{not json', {
        artifactPath: '.harness/results.json',
        exitCode: 1,
      }),
    ).toThrowError(TestResultParseError);

    expect(() =>
      parseVitestJson('{not json', {
        artifactPath: '.harness/results.json',
        exitCode: 1,
      }),
    ).toThrow(/\.harness\/results\.json/);
  });

  it('accepts a run with no suites or tests', async () => {
    const results = await parseFixture('empty.json');

    expect(results.tests.size).toBe(0);
    expect(results.suiteFailures).toEqual([]);
  });

  it('cannot return a passing outcome absent from the reporter document', async () => {
    const results = await parseFixture('empty.json');

    expect(results.tests.get('fabricated passing test')).toBeUndefined();
  });
});
