import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Change, FileEntry } from '../../src/diff/source-diff.js';
import type { ValidatedChangeSet } from '../../src/diff/validate.js';
import {
  compileReviewArgv,
  deriveReviewTargets,
} from '../../src/review/targets.js';
import {
  REVIEW_AFTER_ROOT,
  REVIEW_ARGS,
  REVIEW_BEFORE_ROOT,
} from '../../src/review/policy.js';

function file(path: string, content: string): FileEntry {
  const bytes = Buffer.from(content);
  return {
    path,
    type: 'file',
    mode: 0o644,
    hash: createHash('sha256').update(bytes).digest('hex'),
    content: bytes,
  };
}

function symlink(path: string, target: string): FileEntry {
  return {
    path,
    type: 'symlink',
    mode: 0o777,
    hash: createHash('sha256').update(target).digest('hex'),
    content: Buffer.alloc(0),
    linkTarget: target,
  };
}

function changes(...items: Change[]): ValidatedChangeSet {
  return { changes: items };
}

describe('review targets', () => {
  it('copies added and modified files after, and only modified files before', () => {
    const added = file('src/added.js', 'added');
    const previous = file('src/changed.js', 'before');
    const current = file('src/changed.js', 'after');
    const deleted = file('src/deleted.js', 'deleted');

    const targets = deriveReviewTargets(
      changes(
        { kind: 'added', path: added.path, entry: added },
        { kind: 'modified', path: current.path, previous, entry: current },
        { kind: 'deleted', path: deleted.path, previous: deleted },
      ),
    );

    expect(targets.before.map((target) => target.path)).toEqual(['src/changed.js']);
    expect(targets.after.map((target) => target.path)).toEqual([
      'src/added.js',
      'src/changed.js',
    ]);
    expect(targets.before[0]?.content.toString()).toBe('before');
    expect(targets.after[1]?.content.toString()).toBe('after');
  });

  it('does not filter extensions, but excludes every symlink and delete-only change', () => {
    const unusual = file('assets/source.anything', 'scan me');
    const oldFile = file('src/replaced.js', 'old');
    const newLink = symlink('src/replaced.js', './other.js');
    const oldLink = symlink('src/was-link.js', './old.js');
    const newFile = file('src/was-link.js', 'new');

    expect(
      deriveReviewTargets(
        changes(
          { kind: 'added', path: unusual.path, entry: unusual },
          { kind: 'modified', path: newLink.path, previous: oldFile, entry: newLink },
          { kind: 'modified', path: newFile.path, previous: oldLink, entry: newFile },
        ),
      ),
    ).toEqual({ before: [], after: [{ path: unusual.path, content: unusual.content }] });

    expect(
      deriveReviewTargets(
        changes({ kind: 'deleted', path: oldFile.path, previous: oldFile }),
      ),
    ).toEqual({ before: [], after: [] });
  });

  it('compiles the one fixed offline scanner argv array', () => {
    expect(compileReviewArgv()).toEqual([
      ...REVIEW_ARGS,
      '--',
      REVIEW_BEFORE_ROOT,
      REVIEW_AFTER_ROOT,
    ]);

    const command = compileReviewArgv().join(' ');
    expect(command).not.toMatch(/shell|login|upload|autofix|baseline|\.git|config=auto|p\//i);
  });
});
