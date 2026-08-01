import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

const FIXTURES = fileURLToPath(new URL('../../fixtures', import.meta.url));

/** Isolated from the user's global/system git config, and deterministic. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Harness Test',
  GIT_AUTHOR_EMAIL: 'test@harness.invalid',
  GIT_COMMITTER_NAME: 'Harness Test',
  GIT_COMMITTER_EMAIL: 'test@harness.invalid',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00+0000',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00+0000',
};

export async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', ['-C', dir, ...args], { env: GIT_ENV });
  return stdout;
}

export interface TargetRepo {
  dir: string;
  commit: string;
}

/** Materialize a fixture repository into a temp dir and make it a git repository. */
export async function createRepo(fixture: string): Promise<TargetRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-repo-'));
  await cp(join(FIXTURES, fixture), dir, { recursive: true, verbatimSymlinks: true });
  await git(dir, ['init', '-q', '-b', 'main']);
  const commit = await commitAll(dir, 'Initial commit');
  return { dir, commit };
}

export function createTargetRepo(): Promise<TargetRepo> {
  return createRepo('target-repo');
}

export async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '--no-verify', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

export async function removeRepo(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
