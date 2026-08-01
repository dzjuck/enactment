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

/** DESIGN.md §14. `AI-Harness-Plan` and `AI-Harness-Step` arrive with Milestone 3. */
export const TRAILERS = {
  task: 'AI-Harness-Task',
  attempt: 'AI-Harness-Attempt',
  idempotencyKey: 'AI-Harness-Idempotency-Key',
};

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'AI Harness',
  GIT_AUTHOR_EMAIL: 'harness@localhost',
  GIT_COMMITTER_NAME: 'AI Harness',
  GIT_COMMITTER_EMAIL: 'harness@localhost',
};

export interface AcceptOptions {
  repoPath: string;
  baseCommit: string;
  branch: string;
  taskId: string;
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
 * Apply exactly the validated files to a private worktree and commit them (§14).
 *
 * The user's checked-out branch and working tree are never touched: the worktree is created
 * detached at the base commit, so an unrelated dirty file cannot be swept into the commit.
 * Hooks are disabled two ways — `--no-verify` and `core.hooksPath=/dev/null` — because the
 * repository is allowed to configure a hook path the harness has never seen.
 */
export async function acceptChanges(options: AcceptOptions): Promise<AcceptResult> {
  if (options.verificationStatus !== 'pass') {
    throw new AcceptError(
      `refusing to commit: verification status is "${options.verificationStatus}"`,
    );
  }

  const existing = await findCommitByKey(
    options.repoPath,
    TRAILERS.idempotencyKey,
    options.idempotencyKey,
  );
  if (existing !== undefined) {
    return { commit: existing, branch: options.branch, created: false };
  }

  if (options.changes.length === 0) {
    throw new AcceptError('refusing to commit an empty change set');
  }

  const parent = await mkdtemp(join(tmpdir(), 'harness-worktree-'));
  const worktree = join(parent, 'tree');

  try {
    await git(options.repoPath, ['worktree', 'add', '--detach', worktree, options.baseCommit]);

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
      options.message ?? `${options.taskId}: apply harness-verified changes`,
      '--trailer',
      `${TRAILERS.task}: ${options.taskId}`,
      '--trailer',
      `${TRAILERS.attempt}: ${options.attempt}`,
      '--trailer',
      `${TRAILERS.idempotencyKey}: ${options.idempotencyKey}`,
    ]);

    const commit = await git(worktree, ['rev-parse', 'HEAD']);

    // Creating the branch fails loudly if it already exists: the harness never moves a ref
    // it did not create in this run.
    try {
      await git(options.repoPath, ['branch', options.branch, commit]);
    } catch (error) {
      throw new AcceptError(
        `cannot create branch ${options.branch}: ${error instanceof Error ? error.message : String(error)}`,
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
