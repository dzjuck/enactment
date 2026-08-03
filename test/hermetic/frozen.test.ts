import { describe, expect, it } from 'vitest';

import type { Change, FileEntry } from '../../src/diff/source-diff.js';
import { DiffValidationError, validateChanges } from '../../src/diff/validate.js';
import { frozenPathsForPhase } from '../../src/verify/frozen.js';

const closurePaths = ['package.json', 'vitest.config.*'];
const testPaths = ['test/**'];
const implementationPaths = ['src/**'];

function entry(path: string): FileEntry {
  return {
    path,
    type: 'file',
    mode: 0o644,
    hash: path,
    content: Buffer.from(path),
  };
}

function change(kind: Change['kind'], path: string): Change {
  if (kind === 'added') return { kind, path, entry: entry(path) };
  if (kind === 'deleted') return { kind, path, previous: entry(path) };
  return { kind, path, entry: entry(`${path}-changed`), previous: entry(path) };
}

function catchValidation(changes: Change[], scope: string[], frozen: string[]): DiffValidationError {
  try {
    validateChanges(changes, scope, 'implementation', frozen);
  } catch (error) {
    expect(error).toBeInstanceOf(DiffValidationError);
    return error as DiffValidationError;
  }
  throw new Error('expected validation to fail');
}

describe('frozen verification inputs', () => {
  it('freezes closure paths during tests and closure plus tests during implementation', () => {
    expect(frozenPathsForPhase('tests', closurePaths, testPaths)).toEqual(closurePaths);
    expect(frozenPathsForPhase('implementation', closurePaths, testPaths)).toEqual([
      ...closurePaths,
      ...testPaths,
    ]);
  });

  it('rejects a modified frozen file and names it', () => {
    const error = catchValidation(
      [change('modified', 'test/slugify.test.js')],
      implementationPaths,
      [...closurePaths, ...testPaths],
    );

    expect(error.violation).toBe('closure_violation');
    expect(error.message).toContain('test/slugify.test.js');
  });

  it('rejects a file added under a frozen test path', () => {
    const error = catchValidation(
      [change('added', 'test/extra.test.js')],
      implementationPaths,
      testPaths,
    );

    expect(error.violation).toBe('closure_violation');
    expect(error.path).toBe('test/extra.test.js');
  });

  it('rejects a deleted frozen file', () => {
    const error = catchValidation(
      [change('deleted', 'test/slugify.test.js')],
      implementationPaths,
      testPaths,
    );

    expect(error.violation).toBe('closure_violation');
    expect(error.path).toBe('test/slugify.test.js');
  });

  it('allows an implementation-path change during implementation', () => {
    expect(
      validateChanges(
        [change('added', 'src/slugify.js')],
        implementationPaths,
        'implementation',
        [...closurePaths, ...testPaths],
      ).changes,
    ).toHaveLength(1);
  });

  it('reports closure_violation before out_of_scope', () => {
    const error = catchValidation(
      [change('modified', 'test/slugify.test.js')],
      implementationPaths,
      testPaths,
    );

    expect(error.violation).toBe('closure_violation');
  });
});
