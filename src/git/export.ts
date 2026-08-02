import { createHash } from 'node:crypto';

import { execa, ExecaError } from 'execa';

import { escapesTree } from '../util/paths.js';

export class GitExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitExportError';
  }
}

export interface ExportedTree {
  /** `git archive` output for the commit. */
  tar: Buffer;
  /** sha256 of the tar bytes. */
  hash: string;
}

/**
 * Provider configuration is harness-owned (DESIGN.md §27): repository content must not be
 * able to supply it. `.git/` is never in a `git archive`.
 */
const EXCLUDED = [
  ':(exclude).codex',
  ':(exclude,glob)**/.codex/**',
  ':(exclude,glob)**/*.rules',
];

const SYMLINK_MODE = '120000';

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', ['-C', repoPath, ...args]);
  return stdout;
}

/**
 * A symlink resolving outside the tree would let extraction write outside the workspace,
 * so the whole export is refused rather than silently dropping the entry.
 */
async function assertNoEscapingSymlinks(repoPath: string, commit: string): Promise<void> {
  const listing = await git(repoPath, ['ls-tree', '-r', '-z', commit]);

  for (const record of listing.split('\0')) {
    if (record === '') continue;

    const [meta = '', linkPath = ''] = record.split('\t');
    const [mode = '', , object = ''] = meta.split(/\s+/);
    if (mode !== SYMLINK_MODE) continue;

    const target = await git(repoPath, ['cat-file', 'blob', object]);
    if (escapesTree(linkPath, target)) {
      throw new GitExportError(
        `symlink "${linkPath}" points outside the repository tree (target "${target}")`,
      );
    }
  }
}

/** Export a commit's tree as a deterministic tar. The working tree is never consulted. */
export async function exportCommit(repoPath: string, commit: string): Promise<ExportedTree> {
  let resolved: string;
  try {
    resolved = await git(repoPath, ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`]);
  } catch (error) {
    throw new GitExportError(
      `cannot resolve commit "${commit}" in ${repoPath}: ${
        error instanceof ExecaError ? error.stderr : String(error)
      }`,
    );
  }

  await assertNoEscapingSymlinks(repoPath, resolved);

  const { stdout } = await execa(
    'git',
    ['-C', repoPath, 'archive', '--format=tar', resolved, '--', '.', ...EXCLUDED],
    { encoding: 'buffer' },
  );

  const tar = Buffer.from(stdout);
  return { tar, hash: `sha256:${createHash('sha256').update(tar).digest('hex')}` };
}
