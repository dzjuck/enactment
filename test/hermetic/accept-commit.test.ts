import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acceptChanges, AcceptError, TRAILERS } from '../../src/git/accept.js';
import { idempotencyKey } from '../../src/git/idempotency.js';
import type { Change, FileEntry } from '../../src/diff/source-diff.js';
import { commitAll, createTargetRepo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';

const TASK_ID = 'add-slugify';
const ATTEMPT = 'attempt-1';
const BRANCH = 'ai-harness/add-slugify';

const SLUGIFY = 'export const slugify = (t) => String(t).toLowerCase();\n';

let repo: TargetRepo;
let key: string;

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

const modify = (path: string, content: string): Change => ({
  kind: 'modified',
  path,
  entry: file(path, content),
});

const remove = (path: string): Change => ({
  kind: 'deleted',
  path,
  previous: file(path, ''),
});

beforeEach(async () => {
  repo = await createTargetRepo();
  key = idempotencyKey({
    taskId: TASK_ID,
    taskHash: `sha256:${'a'.repeat(64)}`,
    baseCommit: repo.commit,
    attempt: ATTEMPT,
  });
});

afterEach(async () => {
  await removeRepo(repo.dir);
});

function accept(
  changes: Change[],
  overrides: Partial<Parameters<typeof acceptChanges>[0]> = {},
): ReturnType<typeof acceptChanges> {
  return acceptChanges({
    repoPath: repo.dir,
    baseCommit: repo.commit,
    branch: BRANCH,
    taskId: TASK_ID,
    attempt: ATTEMPT,
    idempotencyKey: key,
    verificationStatus: 'pass',
    changes,
    ...overrides,
  });
}

describe('harness-owned commit', () => {
  it('creates a commit on a harness-created branch', async () => {
    const result = await accept([modify('src/slugify.js', SLUGIFY)]);

    expect(result.created).toBe(true);
    expect(result.branch).toBe(BRANCH);
    expect(await git(repo.dir, ['rev-parse', BRANCH])).toBe(result.commit);
    expect(await git(repo.dir, ['show', `${result.commit}:src/slugify.js`])).toContain('toLowerCase');
  });

  it('leaves the user checked-out branch and working tree untouched', async () => {
    await writeFile(join(repo.dir, 'README.md'), 'user was editing this\n');

    const branchBefore = await git(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const headBefore = await git(repo.dir, ['rev-parse', 'HEAD']);

    await accept([modify('src/slugify.js', SLUGIFY)]);

    expect(await git(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branchBefore);
    expect(await git(repo.dir, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await git(repo.dir, ['status', '--porcelain'])).toContain('README.md');
    expect(await readFile(join(repo.dir, 'README.md'), 'utf8')).toBe('user was editing this\n');
  });

  it('stages only the validated paths', async () => {
    await writeFile(join(repo.dir, 'README.md'), 'unrelated dirty edit\n');

    const result = await accept([modify('src/slugify.js', SLUGIFY)]);
    const touched = await git(repo.dir, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      result.commit,
    ]);

    expect(touched.split('\n')).toEqual(['src/slugify.js']);
  });

  it('applies deletions as deletions', async () => {
    const result = await accept([modify('src/slugify.js', SLUGIFY), remove('AGENTS.md')]);

    const names = await git(repo.dir, [
      'diff-tree',
      '--no-commit-id',
      '--name-status',
      '-r',
      result.commit,
    ]);

    expect(names).toContain('D\tAGENTS.md');
    await expect(git(repo.dir, ['show', `${result.commit}:AGENTS.md`])).rejects.toThrow();
  });

  it('writes the Milestone 1 trailers', async () => {
    const result = await accept([modify('src/slugify.js', SLUGIFY)]);
    const message = await git(repo.dir, ['log', '-1', '--format=%B', result.commit]);

    expect(message).toContain(`${TRAILERS.task}: ${TASK_ID}`);
    expect(message).toContain(`${TRAILERS.attempt}: ${ATTEMPT}`);
    expect(message).toContain(`${TRAILERS.idempotencyKey}: ${key}`);
  });

  it('is not blocked by a repository pre-commit hook, and does not run it', async () => {
    await git(repo.dir, ['config', 'core.hooksPath', '.githooks']);

    const result = await accept([modify('src/slugify.js', SLUGIFY)]);

    expect(result.created).toBe(true);
    await expect(readFile(join(repo.dir, 'HOOK_RAN'), 'utf8')).rejects.toThrow();
  });

  it('does not create a second commit for the same idempotency key', async () => {
    const first = await accept([modify('src/slugify.js', SLUGIFY)]);
    const second = await accept([modify('src/slugify.js', `${SLUGIFY}// different\n`)]);

    expect(second.created).toBe(false);
    expect(second.commit).toBe(first.commit);
    expect(await git(repo.dir, ['rev-list', '--count', BRANCH])).toBe('2');
  });

  it('creates no commit when verification did not pass', async () => {
    const before = await git(repo.dir, ['rev-list', '--all', '--count']);

    await expect(
      accept([modify('src/slugify.js', SLUGIFY)], { verificationStatus: 'fail' }),
    ).rejects.toThrow(AcceptError);

    expect(await git(repo.dir, ['rev-list', '--all', '--count'])).toBe(before);
  });

  it('merges nothing and pushes nothing', async () => {
    const baseBefore = await git(repo.dir, ['rev-parse', 'main']);

    const result = await accept([modify('src/slugify.js', SLUGIFY)]);

    expect(await git(repo.dir, ['rev-parse', 'main'])).toBe(baseBefore);
    expect(await git(repo.dir, ['remote'])).toBe('');
    await expect(
      execa('git', ['-C', repo.dir, 'merge-base', '--is-ancestor', result.commit, 'main']),
    ).rejects.toThrow();
  });

  it('removes the private worktree, including when the commit fails', async () => {
    await git(repo.dir, ['branch', BRANCH, repo.commit]);

    await expect(accept([modify('src/slugify.js', SLUGIFY)])).rejects.toThrow(AcceptError);

    const worktrees = await git(repo.dir, ['worktree', 'list']);
    expect(worktrees.split('\n')).toHaveLength(1);
    expect(worktrees).toContain(repo.dir.replace(/^\/private/, ''));
  });

  it('removes the private worktree after a successful commit', async () => {
    await accept([modify('src/slugify.js', SLUGIFY)]);
    await commitAll(repo.dir, 'user keeps working').catch(() => undefined);

    expect((await git(repo.dir, ['worktree', 'list'])).split('\n')).toHaveLength(1);
  });
});
