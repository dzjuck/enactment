import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acceptChanges, AcceptError } from '../../src/git/accept.js';
import { TRAILERS } from '../../src/git/idempotency.js';
import { idempotencyKey, type IdempotencyInputs } from '../../src/git/idempotency.js';
import type { Change, FileEntry } from '../../src/diff/source-diff.js';
import { commitAll, createTargetRepo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';

const PLAN_ID = 'slugify-plan';
const STEP_ID = 'add-slugify';
const ATTEMPT = 'attempt-1';
const BRANCH = `ai-harness/${PLAN_ID}`;
const MANIFEST_HASH = `sha256:${'a'.repeat(64)}`;

const SLUGIFY = 'export const slugify = (t) => String(t).toLowerCase();\n';
const SECOND = 'export const shout = (t) => String(t).toUpperCase();\n';

let repo: TargetRepo;

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

function keyFor(overrides: Partial<IdempotencyInputs> = {}): string {
  return idempotencyKey({
    manifestHash: MANIFEST_HASH,
    planId: PLAN_ID,
    stepId: STEP_ID,
    attempt: ATTEMPT,
    parentCommit: repo.commit,
    ...overrides,
  });
}

beforeEach(async () => {
  repo = await createTargetRepo();
});

afterEach(async () => {
  await removeRepo(repo.dir);
});

function accept(
  changes: Change[],
  overrides: Partial<Parameters<typeof acceptChanges>[0]> = {},
): ReturnType<typeof acceptChanges> {
  const parentCommit = overrides.parentCommit ?? repo.commit;

  return acceptChanges({
    repoPath: repo.dir,
    parentCommit,
    branchExists: false,
    branch: BRANCH,
    planId: PLAN_ID,
    stepId: STEP_ID,
    attempt: ATTEMPT,
    idempotencyKey: keyFor({ parentCommit }),
    verificationStatus: 'pass',
    changes,
    ...overrides,
  });
}

describe('plan branch acceptance', () => {
  it('creates the plan branch at a child of the approved base', async () => {
    const result = await accept([modify('src/slugify.js', SLUGIFY)]);

    expect(result.created).toBe(true);
    expect(result.branch).toBe(BRANCH);
    expect(await git(repo.dir, ['rev-parse', BRANCH])).toBe(result.commit);
    expect(await git(repo.dir, ['rev-parse', `${result.commit}^`])).toBe(repo.commit);
    expect(await git(repo.dir, ['rev-list', '--count', BRANCH])).toBe('2');
  });

  it('advances the same branch linearly for the next step', async () => {
    const first = await accept([modify('src/slugify.js', SLUGIFY)]);

    const second = await accept([modify('src/shout.js', SECOND)], {
      stepId: 'add-shout',
      attempt: 'attempt-2',
      parentCommit: first.commit,
      branchExists: true,
      idempotencyKey: keyFor({
        stepId: 'add-shout',
        attempt: 'attempt-2',
        parentCommit: first.commit,
      }),
    });

    expect(second.created).toBe(true);
    expect(await git(repo.dir, ['rev-parse', BRANCH])).toBe(second.commit);
    expect(await git(repo.dir, ['rev-parse', `${second.commit}^`])).toBe(first.commit);
    expect(await git(repo.dir, ['rev-list', '--count', BRANCH])).toBe('3');
    // Linear: the second commit carries the first step's file as well.
    expect(await git(repo.dir, ['show', `${second.commit}:src/slugify.js`])).toContain(
      'toLowerCase',
    );
  });

  it('writes the plan, step, attempt and idempotency trailers and no task trailer', async () => {
    const result = await accept([modify('src/slugify.js', SLUGIFY)]);
    const message = await git(repo.dir, ['log', '-1', '--format=%B', result.commit]);

    expect(message).toContain(`${TRAILERS.plan}: ${PLAN_ID}`);
    expect(message).toContain(`${TRAILERS.step}: ${STEP_ID}`);
    expect(message).toContain(`${TRAILERS.attempt}: ${ATTEMPT}`);
    expect(message).toContain(`${TRAILERS.idempotencyKey}: ${keyFor()}`);
    expect(message).not.toContain('AI-Harness-Task');
  });

  it('refuses the first acceptance when the plan branch already exists', async () => {
    await git(repo.dir, ['branch', BRANCH, repo.commit]);
    const before = await git(repo.dir, ['rev-parse', BRANCH]);

    await expect(accept([modify('src/slugify.js', SLUGIFY)])).rejects.toThrow(AcceptError);

    expect(await git(repo.dir, ['rev-parse', BRANCH])).toBe(before);
  });

  it('refuses a later step when the expected ref is missing', async () => {
    const error = await accept([modify('src/slugify.js', SLUGIFY)], {
      branchExists: true,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AcceptError);
    await expect(git(repo.dir, ['rev-parse', '--verify', BRANCH])).rejects.toThrow();
  });

  it('refuses a later step when the ref was moved, and does not force it back', async () => {
    const first = await accept([modify('src/slugify.js', SLUGIFY)]);
    await writeFile(join(repo.dir, 'README.md'), 'user commit\n');
    const moved = await commitAll(repo.dir, 'user moved the plan branch');
    await git(repo.dir, ['update-ref', `refs/heads/${BRANCH}`, moved]);

    const error = await accept([modify('src/shout.js', SECOND)], {
      stepId: 'add-shout',
      attempt: 'attempt-2',
      parentCommit: first.commit,
      branchExists: true,
      idempotencyKey: keyFor({
        stepId: 'add-shout',
        attempt: 'attempt-2',
        parentCommit: first.commit,
      }),
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AcceptError);
    expect(await git(repo.dir, ['rev-parse', BRANCH])).toBe(moved);
  });

  it('returns the existing commit for a repeated key and does not advance the branch', async () => {
    const first = await accept([modify('src/slugify.js', SLUGIFY)]);

    const second = await accept([modify('src/slugify.js', `${SLUGIFY}// different\n`)]);

    expect(second.created).toBe(false);
    expect(second.commit).toBe(first.commit);
    expect(await git(repo.dir, ['rev-parse', BRANCH])).toBe(first.commit);
    expect(await git(repo.dir, ['rev-list', '--count', BRANCH])).toBe('2');
  });

  it('ignores a matching key that is not reachable from the plan branch', async () => {
    const first = await accept([modify('src/slugify.js', SLUGIFY)]);
    await git(repo.dir, ['branch', 'someone-elses-branch', first.commit]);
    await git(repo.dir, ['update-ref', '-d', `refs/heads/${BRANCH}`]);

    const again = await accept([modify('src/slugify.js', SLUGIFY)]);

    // Not compared by SHA: the recreated commit has the same tree, parent, message and
    // trailers, so within one clock second Git hashes it to the same object. What matters is
    // that the orphaned commit was not reported as this plan's accepted work.
    expect(again.created).toBe(true);
    expect(await git(repo.dir, ['rev-parse', BRANCH])).toBe(again.commit);
  });
});

describe('plan-scoped idempotency key', () => {
  it('is stable for the same manifest, plan, step, attempt and parent', () => {
    expect(keyFor()).toBe(keyFor());
    expect(keyFor()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ['manifestHash', { manifestHash: `sha256:${'9'.repeat(64)}` }],
    ['planId', { planId: 'other-plan' }],
    ['stepId', { stepId: 'other-step' }],
    ['attempt', { attempt: 'attempt-2' }],
    ['parentCommit', { parentCommit: 'f'.repeat(40) }],
  ] satisfies [string, Partial<IdempotencyInputs>][])(
    'changes when %s changes',
    (_label, override) => {
      expect(keyFor(override)).not.toBe(keyFor());
    },
  );
});

describe('harness-owned commit', () => {
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

  it('is not blocked by a repository pre-commit hook, and does not run it', async () => {
    await git(repo.dir, ['config', 'core.hooksPath', '.githooks']);

    const result = await accept([modify('src/slugify.js', SLUGIFY)]);

    expect(result.created).toBe(true);
    await expect(readFile(join(repo.dir, 'HOOK_RAN'), 'utf8')).rejects.toThrow();
  });

  it('creates no commit when verification did not pass', async () => {
    const before = await git(repo.dir, ['rev-list', '--all', '--count']);

    await expect(
      accept([modify('src/slugify.js', SLUGIFY)], { verificationStatus: 'fail' }),
    ).rejects.toThrow(AcceptError);

    expect(await git(repo.dir, ['rev-list', '--all', '--count'])).toBe(before);
  });

  it('refuses an empty change set', async () => {
    await expect(accept([])).rejects.toThrow(AcceptError);
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
    // A change carrying no content fails inside the worktree, after it was created.
    const broken: Change = { kind: 'modified', path: 'src/slugify.js' };

    await expect(accept([broken])).rejects.toThrow(AcceptError);

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
