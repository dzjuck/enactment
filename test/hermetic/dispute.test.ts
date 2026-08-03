import { describe, expect, it } from 'vitest';

import type { Change, FileEntry } from '../../src/diff/source-diff.js';
import { DiffValidationError, validateChanges } from '../../src/diff/validate.js';
import {
  captureTestContractDispute,
  DISPUTE_PATH,
  excludeDispute,
  implementationScopeWithDispute,
} from '../../src/verify/dispute.js';

function entry(path: string, content: string): FileEntry {
  return {
    path,
    type: 'file',
    mode: 0o644,
    hash: content,
    content: Buffer.from(content),
  };
}

function added(path: string, content: string): Change {
  return { kind: 'added', path, entry: entry(path, content) };
}

describe('test-contract dispute', () => {
  it('recognizes the harness-owned dispute file and captures its reason', () => {
    const dispute = captureTestContractDispute([
      added(DISPUTE_PATH, 'The expected punctuation contradicts the task.'),
    ]);

    expect(dispute).toEqual({
      path: DISPUTE_PATH,
      reason: 'The expected punctuation contradicts the task.',
    });
  });

  it('allows only the dispute path outside implementation scope and excludes it from acceptance', () => {
    const implementation = added('src/slugify.js', 'implementation');
    const dispute = added(DISPUTE_PATH, 'The test contract is inconsistent.');
    const scope = implementationScopeWithDispute(['src/**']);
    const validated = validateChanges(
      [implementation, dispute],
      scope,
      'implementation',
      ['test/**'],
    );

    expect(excludeDispute(validated.changes)).toEqual([implementation]);
    expect(() =>
      validateChanges([added('README.md', 'no')], scope, 'implementation', ['test/**']),
    ).toThrow(DiffValidationError);
  });
});
