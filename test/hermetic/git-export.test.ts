import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitExportError, exportCommit } from '../../src/git/export.js';
import { commitAll, createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { readTar, type TarEntry } from '../helpers/tar.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/target-repo', import.meta.url));

let repo: TargetRepo;

beforeEach(async () => {
  repo = await createTargetRepo();
});

afterEach(async () => {
  await removeRepo(repo.dir);
});

async function exportEntries(): Promise<TarEntry[]> {
  const { tar } = await exportCommit(repo.dir, repo.commit);
  return readTar(tar);
}

function paths(entries: TarEntry[]): string[] {
  return entries.filter((entry) => entry.type !== 'directory').map((entry) => entry.path);
}

describe('exportCommit', () => {
  it('exports exactly the committed tree', async () => {
    const entries = await exportEntries();

    expect(paths(entries).sort()).toEqual(
      [
        '.githooks/pre-commit',
        'AGENTS.md',
        'README.md',
        'docs/readme.md',
        'package.json',
        'src/slugify.js',
        'test/slugify.test.js',
        'vitest.config.js',
      ].sort(),
    );

    const exported = entries.find((entry) => entry.path === 'src/slugify.js');
    expect(exported?.content).toEqual(await readFile(join(FIXTURE, 'src/slugify.js')));
  });

  it('omits .git/', async () => {
    const entries = await exportEntries();
    expect(entries.filter((entry) => entry.path.startsWith('.git/'))).toEqual([]);
  });

  it('omits repository-controlled provider configuration', async () => {
    const entries = await exportEntries();
    const all = entries.map((entry) => entry.path);

    expect(all).not.toContain('.codex/config.toml');
    expect(all).not.toContain('.codex/hooks.json');
    expect(all).not.toContain('policy.rules');
    expect(all.filter((path) => path.endsWith('.rules'))).toEqual([]);
    expect(all.filter((path) => path === '.codex' || path.startsWith('.codex/'))).toEqual([]);
  });

  it('includes AGENTS.md, and its content contributes to the export hash', async () => {
    const before = await exportCommit(repo.dir, repo.commit);
    expect(paths(readTar(before.tar))).toContain('AGENTS.md');

    await writeFile(join(repo.dir, 'AGENTS.md'), '# Agent instructions\n\nChanged.\n');
    const changed = await commitAll(repo.dir, 'Edit AGENTS.md');
    const after = await exportCommit(repo.dir, changed);

    expect(after.hash).not.toBe(before.hash);
  });

  it('exports the commit, not the working tree', async () => {
    const before = await exportCommit(repo.dir, repo.commit);

    await writeFile(join(repo.dir, 'src/slugify.js'), 'export const slugify = () => "dirty";\n');
    await writeFile(join(repo.dir, 'untracked.js'), 'nonsense\n');

    const after = await exportCommit(repo.dir, repo.commit);

    expect(after.tar.equals(before.tar)).toBe(true);
    expect(after.hash).toBe(before.hash);
  });

  it('preserves file modes, including the executable bit', async () => {
    const entries = await exportEntries();

    const hook = entries.find((entry) => entry.path === '.githooks/pre-commit');
    const readme = entries.find((entry) => entry.path === 'README.md');

    expect(hook?.mode).toBeDefined();
    expect((hook?.mode ?? 0) & 0o111).not.toBe(0);
    expect((readme?.mode ?? 0) & 0o111).toBe(0);
  });

  it('preserves symlinks as symlinks', async () => {
    const entries = await exportEntries();
    const link = entries.find((entry) => entry.path === 'docs/readme.md');

    expect(link?.type).toBe('symlink');
    expect(link?.linkPath).toBe('../README.md');
  });

  it('rejects a symlink pointing outside the tree', async () => {
    await symlink('../../../etc/passwd', join(repo.dir, 'escape'));
    const commit = await commitAll(repo.dir, 'Add escaping symlink');

    await expect(exportCommit(repo.dir, commit)).rejects.toThrow(GitExportError);
    await expect(exportCommit(repo.dir, commit)).rejects.toThrow(/escape/);
  });

  it('rejects an unknown commit', async () => {
    await expect(
      exportCommit(repo.dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    ).rejects.toThrow(GitExportError);
  });

  it('is byte-for-byte deterministic', async () => {
    const first = await exportCommit(repo.dir, repo.commit);
    const second = await exportCommit(repo.dir, repo.commit);

    expect(second.tar.equals(first.tar)).toBe(true);
    expect(second.hash).toBe(first.hash);
    expect(first.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
