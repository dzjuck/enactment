import { createHash } from 'node:crypto';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  diffManifests,
  manifestFromTar,
  sourceDiff,
  type Change,
  type FileEntry,
  type FileManifest,
} from '../../src/diff/source-diff.js';
import { DiffValidationError, validateChanges } from '../../src/diff/validate.js';
import { exportCommit } from '../../src/git/export.js';
import { commitAll, createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';

const PATHS = ['src/slugify.js', 'src/util/**'];

let repo: TargetRepo;
let before: Buffer;

beforeEach(async () => {
  repo = await createTargetRepo();
  ({ tar: before } = await exportCommit(repo.dir, repo.commit));
});

afterEach(async () => {
  await removeRepo(repo.dir);
});

async function after(mutate: () => Promise<void>): Promise<Buffer> {
  await mutate();
  const commit = await commitAll(repo.dir, 'Agent changes');
  const { tar } = await exportCommit(repo.dir, commit);
  return tar;
}

function file(path: string, content: string, mode = 0o644): FileEntry {
  const bytes = Buffer.from(content);
  return {
    path,
    type: 'file',
    mode,
    hash: createHash('sha256').update(bytes).digest('hex'),
    content: bytes,
  };
}

function manifest(...entries: FileEntry[]): FileManifest {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function change(kind: Change['kind'], entry: FileEntry): Change {
  return kind === 'deleted' ? { kind, path: entry.path, previous: entry } : { kind, path: entry.path, entry };
}

describe('source diff', () => {
  it('detects additions, modifications and deletions', async () => {
    const tar = await after(async () => {
      await writeFile(join(repo.dir, 'src/slugify.js'), 'export const slugify = () => "x";\n');
      await writeFile(join(repo.dir, 'src/helper.js'), 'export const helper = 1;\n');
      await rm(join(repo.dir, 'AGENTS.md'));
    });

    const changes = await sourceDiff(before, tar);
    const byPath = new Map(changes.map((entry) => [entry.path, entry.kind]));

    expect(byPath.get('src/slugify.js')).toBe('modified');
    expect(byPath.get('src/helper.js')).toBe('added');
    expect(byPath.get('AGENTS.md')).toBe('deleted');
    expect(changes).toHaveLength(3);
  });

  it('excludes node_modules and .git from the source diff', () => {
    const changes = diffManifests(
      manifest(file('src/slugify.js', 'before')),
      manifest(
        file('src/slugify.js', 'before'),
        file('node_modules/pkg/index.js', 'installed'),
        file('.git/HEAD', 'ref: refs/heads/main'),
      ),
    );

    expect(changes).toEqual([]);
  });

  it('detects a mode-only change', async () => {
    const tar = await after(async () => {
      await chmod(join(repo.dir, 'src/slugify.js'), 0o755);
    });

    const changes = await sourceDiff(before, tar);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('modified');
    expect(changes[0]?.entry?.mode).toBeDefined();
    expect((changes[0]?.entry?.mode ?? 0) & 0o111).not.toBe(0);
  });

  it('carries the validated file set forward, not the live workspace', async () => {
    const accepted = await after(async () => {
      await writeFile(join(repo.dir, 'src/slugify.js'), 'export const slugify = () => "accepted";\n');
    });
    const validated = validateChanges(await sourceDiff(before, accepted), PATHS);

    // The workspace keeps moving after the snapshot; what was accepted must not.
    await after(async () => {
      await writeFile(join(repo.dir, 'src/slugify.js'), 'export const slugify = () => "later";\n');
    });

    const carried = validated.changes.find((entry) => entry.path === 'src/slugify.js');
    expect(carried?.entry?.content.toString()).toContain('accepted');
    expect(carried?.entry?.content.toString()).not.toContain('later');
  });

  it('reads a tar into a manifest with content, mode and symlink targets', async () => {
    const parsed = await manifestFromTar(before);

    expect(parsed.get('src/slugify.js')?.content.toString()).toContain('slugify');
    expect(parsed.get('docs/readme.md')?.type).toBe('symlink');
    expect(parsed.get('docs/readme.md')?.linkTarget).toBe('../README.md');
    expect(parsed.has('.codex/config.toml')).toBe(false);
  });
});

describe('diff validation', () => {
  it('accepts a change under a declared implementation path', () => {
    const changes = [
      change('modified', file('src/slugify.js', 'new')),
      change('added', file('src/util/case.js', 'helper')),
    ];

    expect(validateChanges(changes, PATHS).changes).toHaveLength(2);
  });

  it('rejects a change outside the declared paths, naming it', () => {
    const changes = [
      change('modified', file('src/slugify.js', 'new')),
      change('modified', file('README.md', 'sneaky')),
    ];

    const error = catchValidation(changes);
    expect(error.violation).toBe('out_of_scope');
    expect(error.message).toContain('README.md');
  });

  it('rejects a dependency-manifest change with its own violation', () => {
    for (const path of ['package.json', 'package-lock.json']) {
      const error = catchValidation([change('modified', file(path, '{}'))]);

      expect(error.violation).toBe('dependency_change');
      expect(error.violation).not.toBe('out_of_scope');
      expect(error.message).toContain(path);
    }
  });

  it('rejects an empty diff rather than committing nothing', () => {
    expect(catchValidation([]).violation).toBe('no_changes');
  });

  it('rejects a new symlink pointing outside the workspace', () => {
    const escaping: FileEntry = {
      path: 'src/escape',
      type: 'symlink',
      mode: 0o777,
      hash: '',
      content: Buffer.alloc(0),
      linkTarget: '../../../etc/passwd',
    };

    const error = catchValidation([change('added', escaping)]);
    expect(error.violation).toBe('unsafe_symlink');
    expect(error.message).toContain('src/escape');
  });

  it('accepts a symlink that stays inside the workspace', () => {
    const inside: FileEntry = {
      path: 'src/util/link.js',
      type: 'symlink',
      mode: 0o777,
      hash: '',
      content: Buffer.alloc(0),
      linkTarget: '../slugify.js',
    };

    expect(validateChanges([change('added', inside)], PATHS).changes).toHaveLength(1);
  });
});

function catchValidation(changes: Change[]): DiffValidationError {
  try {
    validateChanges(changes, PATHS);
  } catch (cause) {
    expect(cause).toBeInstanceOf(DiffValidationError);
    return cause as DiffValidationError;
  }
  throw new Error('expected validation to reject the change set');
}
