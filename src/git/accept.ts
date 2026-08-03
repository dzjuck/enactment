import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { execa } from 'execa';

import type { Change } from '../diff/source-diff.js';
import { findCommitByKey } from './idempotency.js';

export class AcceptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptError';
  }
}

/** DESIGN.md §14. */
export const TRAILERS = {
  plan: 'AI-Harness-Plan',
  step: 'AI-Harness-Step',
  attempt: 'AI-Harness-Attempt',
  idempotencyKey: 'AI-Harness-Idempotency-Key',
};

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'AI Harness',
  GIT_AUTHOR_EMAIL: 'harness@localhost',
  GIT_COMMITTER_NAME: 'AI Harness',
  GIT_COMMITTER_EMAIL: 'harness@localhost',
};

/** `git update-ref` reads an empty old value as "the ref must not exist". */
const MUST_NOT_EXIST = '';

export interface AcceptOptions {
  repoPath: string;
  /** The commit this step's work is built on, and where the plan branch must already be. */
  parentCommit: string;
  /** False for a plan's first acceptance, where the branch must not exist yet. */
  branchExists: boolean;
  /** `ai-harness/<plan-id>`: one stable branch per plan. */
  branch: string;
  planId: string;
  stepId: string;
  attempt: string;
  idempotencyKey: string;
  verificationStatus: 'pass' | 'fail' | 'timeout';
  changes: Change[];
  message?: string;
}

export interface AcceptResult {
  commit: string;
  branch: string;
  /** False when an existing commit with the same idempotency key was reused. */
  created: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', ['-C', cwd, ...args], { env: COMMIT_ENV });
  return stdout;
}

async function refCommit(repoPath: string, branch: string): Promise<string | undefined> {
  const { stdout, exitCode } = await execa(
    'git',
    ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    { reject: false },
  );

  return exitCode === 0 && stdout.trim() !== '' ? stdout.trim() : undefined;
}

async function applyChange(worktree: string, change: Change): Promise<void> {
  const path = join(worktree, change.path);

  if (change.kind === 'deleted') {
    await rm(path, { force: true });
    return;
  }

  const entry = change.entry;
  if (entry === undefined) {
    throw new AcceptError(`change for "${change.path}" carries no content to apply`);
  }

  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });

  if (entry.type === 'symlink') {
    await symlink(entry.linkTarget ?? '', path);
    return;
  }

  await writeFile(path, entry.content);
  await chmod(path, entry.mode & 0o777);
}

/**
 * Apply exactly the validated files to a private worktree, commit them, and advance the plan
 * branch to that commit (§14).
 *
 * The user's checked-out branch and working tree are never touched: the worktree is created
 * detached at the parent commit, so an unrelated dirty file cannot be swept into the commit.
 * Hooks are disabled two ways — `--no-verify` and `core.hooksPath=/dev/null` — because the
 * repository is allowed to configure a hook path the harness has never seen.
 *
 * The branch moves through `git update-ref` with an expected old value, so the harness only
 * ever advances a ref it still recognises. A plan branch someone moved, deleted or created
 * behind its back fails the step; it is never forced back into line.
 */
export async function acceptChanges(options: AcceptOptions): Promise<AcceptResult> {
  if (options.verificationStatus !== 'pass') {
    throw new AcceptError(
      `refusing to commit: verification status is "${options.verificationStatus}"`,
    );
  }

  const current = await refCommit(options.repoPath, options.branch);

  // Checked before the ref expectations: a repeated acceptance of an already committed
  // attempt is the recovery path, and there the branch is legitimately past this parent.
  if (current !== undefined) {
    const existing = await findCommitByKey(
      options.repoPath,
      options.branch,
      TRAILERS.idempotencyKey,
      options.idempotencyKey,
    );

    if (existing !== undefined) {
      const message = await git(options.repoPath, ['log', '-1', '--format=%B', existing]);
      if (!message.includes(`${TRAILERS.step}: ${options.stepId}`)) {
        throw new AcceptError(
          `commit ${existing} carries this idempotency key but not step "${options.stepId}"`,
        );
      }

      const parent = await git(options.repoPath, ['rev-parse', `${existing}^`]);
      if (parent !== options.parentCommit) {
        throw new AcceptError(
          `commit ${existing} carries this idempotency key but its parent is ${parent}, not ${options.parentCommit}`,
        );
      }

      return { commit: existing, branch: options.branch, created: false };
    }
  }

  if (options.branchExists) {
    if (current === undefined) {
      throw new AcceptError(
        `plan branch ${options.branch} is missing; it should be at ${options.parentCommit}`,
      );
    }
    if (current !== options.parentCommit) {
      throw new AcceptError(
        `plan branch ${options.branch} is at ${current}, not the expected ${options.parentCommit}`,
      );
    }
  } else if (current !== undefined) {
    throw new AcceptError(
      `plan branch ${options.branch} already exists at ${current}; the harness never adopts a ref it did not create`,
    );
  }

  if (options.changes.length === 0) {
    throw new AcceptError('refusing to commit an empty change set');
  }

  const parent = await mkdtemp(join(tmpdir(), 'harness-worktree-'));
  const worktree = join(parent, 'tree');

  try {
    await git(options.repoPath, ['worktree', 'add', '--detach', worktree, options.parentCommit]);

    for (const change of options.changes) {
      await applyChange(worktree, change);
    }

    await git(worktree, ['add', '--all', '--', ...options.changes.map((change) => change.path)]);

    await git(worktree, [
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--no-verify',
      '--message',
      options.message ?? `${options.stepId}: apply harness-verified changes`,
      '--trailer',
      `${TRAILERS.plan}: ${options.planId}`,
      '--trailer',
      `${TRAILERS.step}: ${options.stepId}`,
      '--trailer',
      `${TRAILERS.attempt}: ${options.attempt}`,
      '--trailer',
      `${TRAILERS.idempotencyKey}: ${options.idempotencyKey}`,
    ]);

    const commit = await git(worktree, ['rev-parse', 'HEAD']);

    try {
      await git(options.repoPath, [
        'update-ref',
        `refs/heads/${options.branch}`,
        commit,
        options.branchExists ? options.parentCommit : MUST_NOT_EXIST,
      ]);
    } catch (error) {
      throw new AcceptError(
        `cannot advance ${options.branch} to ${commit}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return { commit, branch: options.branch, created: true };
  } finally {
    await execa('git', ['-C', options.repoPath, 'worktree', 'remove', '--force', worktree], {
      reject: false,
    });
    await rm(parent, { recursive: true, force: true });
  }
}
