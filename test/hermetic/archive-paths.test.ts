import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { ArchiveError, readArchive } from '../../src/artifacts/archive.js';
import { manifestFromTar, sourceDiff } from '../../src/diff/source-diff.js';
import { DiffValidationError, validateChanges } from '../../src/diff/validate.js';
import { exportCommit } from '../../src/git/export.js';

/**
 * Paths that exercise the header forms Git and GNU tar actually emit.
 *
 * Over 100 bytes with no split point at a `/` inside the first 155, Git cannot use the ustar
 * `prefix` field, so it writes a PAX extended header and names the real entry
 * `<sha>.data`. A reader that ignores the PAX record reports that fabricated name as the
 * file's path — the change would be attributed to a file that does not exist.
 */
const LONG_SEGMENT = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LONG_PATH = `src/${LONG_SEGMENT}-${LONG_SEGMENT}-${LONG_SEGMENT}-${LONG_SEGMENT}/deep.js`;

const TRAILING_SPACE = 'src/trailing space ';
const NO_TRAILING_SPACE = 'src/trailing space';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', ['-C', dir, ...args], { env: GIT_ENV });
  return stdout;
}

async function repoWith(files: Record<string, string>): Promise<{ dir: string; commit: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-archive-'));
  dirs.push(dir);
  await git(dir, ['init', '-q', '-b', 'main']);

  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }

  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '--no-verify', '-m', 'initial']);
  return { dir, commit: await git(dir, ['rev-parse', 'HEAD']) };
}

/**
 * GNU tar spells the format `gnu`; bsdtar (macOS) spells it `gnutar`. Snapshots are produced
 * by GNU tar inside a container, but this suite is hermetic and runs on the host, so it uses
 * whichever spelling the host's tar accepts rather than assuming one.
 */
let gnuFormatArgs: string[] | undefined;

async function gnuFormat(): Promise<string[]> {
  if (gnuFormatArgs !== undefined) return gnuFormatArgs;

  const empty = await mkdtemp(join(tmpdir(), 'harness-tar-probe-'));
  dirs.push(empty);

  for (const args of [['--format=gnu'], ['--format', 'gnutar']]) {
    const probe = await execa(
      'tar',
      ['--create', ...args, '--file', '/dev/null', '--directory', empty, '.'],
      { reject: false },
    );
    if (probe.exitCode === 0) {
      gnuFormatArgs = args;
      return args;
    }
  }

  throw new Error('no GNU tar format supported by the host tar');
}

/** A GNU-format archive of a directory, which is what workspace snapshots produce. */
async function gnuTar(files: Record<string, string>, links: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'harness-gnu-'));
  dirs.push(dir);

  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  for (const [path, target] of Object.entries(links)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await symlink(target, join(dir, path));
  }

  const { stdout } = await execa(
    'tar',
    ['--create', ...(await gnuFormat()), '--file', '-', '--directory', dir, '.'],
    { encoding: 'buffer', stripFinalNewline: false },
  );

  return Buffer.from(stdout);
}

describe('archive path fidelity', () => {
  it('keeps a trailing space distinct from the same name without one', async () => {
    const { dir, commit } = await repoWith({
      [TRAILING_SPACE]: 'with space\n',
      [NO_TRAILING_SPACE]: 'without space\n',
    });

    const { tar } = await exportCommit(dir, commit);
    const manifest = await manifestFromTar(tar);

    expect([...manifest.keys()]).toEqual(
      expect.arrayContaining([TRAILING_SPACE, NO_TRAILING_SPACE]),
    );
    expect(manifest.get(TRAILING_SPACE)?.content.toString()).toBe('with space\n');
    expect(manifest.get(NO_TRAILING_SPACE)?.content.toString()).toBe('without space\n');
  });

  it('carries a trailing space through export, diff and acceptance', async () => {
    const before = await repoWith({ 'src/keep.js': 'x\n' });
    const after = await repoWith({
      'src/keep.js': 'x\n',
      [TRAILING_SPACE]: 'added\n',
    });

    const changes = await sourceDiff(
      (await exportCommit(before.dir, before.commit)).tar,
      (await exportCommit(after.dir, after.commit)).tar,
    );

    const added = changes.filter((change) => change.kind === 'added');
    expect(added.map((change) => change.path)).toEqual([TRAILING_SPACE]);

    // Accepted under its real name: a scope declared without the space must not cover it.
    expect(() => validateChanges(changes, [TRAILING_SPACE])).not.toThrow();
    expect(() => validateChanges(changes, [NO_TRAILING_SPACE])).toThrow(DiffValidationError);
  });

  it('reports a PAX long path under its real path, never the placeholder header name', async () => {
    // Over 100 bytes with no `/` inside the first 155 to split on: the ustar prefix field
    // cannot represent it, so Git must fall back to a PAX extended header.
    expect(LONG_PATH.length).toBeGreaterThan(100);

    const { dir, commit } = await repoWith({ [LONG_PATH]: 'deep\n' });
    const { tar } = await exportCommit(dir, commit);

    const entries = await readArchive(tar);
    const paths = entries.map((entry) => entry.path);

    expect(paths).toContain(LONG_PATH);
    expect(paths.some((path) => path.endsWith('.data'))).toBe(false);
    expect(paths.some((path) => path.endsWith('.paxheader'))).toBe(false);
  });

  it('accepts a PAX long path under its full real path', async () => {
    const before = await repoWith({ 'src/keep.js': 'x\n' });
    const after = await repoWith({ 'src/keep.js': 'x\n', [LONG_PATH]: 'deep\n' });

    const changes = await sourceDiff(
      (await exportCommit(before.dir, before.commit)).tar,
      (await exportCommit(after.dir, after.commit)).tar,
    );

    expect(changes.map((change) => change.path)).toEqual([LONG_PATH]);

    const validated = validateChanges(changes, ['src/**']);
    expect(validated.changes[0]?.path).toBe(LONG_PATH);
    expect(validated.changes[0]?.entry?.content.toString()).toBe('deep\n');
  });

  it('rejects a long out-of-scope path using its real path', async () => {
    const outOfScope = LONG_PATH.replace(/^src\//, 'elsewhere/');

    const before = await repoWith({ 'src/keep.js': 'x\n' });
    const after = await repoWith({ 'src/keep.js': 'x\n', [outOfScope]: 'deep\n' });

    const changes = await sourceDiff(
      (await exportCommit(before.dir, before.commit)).tar,
      (await exportCommit(after.dir, after.commit)).tar,
    );

    const failure = (() => {
      try {
        validateChanges(changes, ['src/**']);
        return undefined;
      } catch (cause: unknown) {
        return cause;
      }
    })();

    expect(failure).toBeInstanceOf(DiffValidationError);
    expect((failure as DiffValidationError).path).toBe(outOfScope);
    expect((failure as Error).message).toContain(outOfScope);
  });

  it('decodes GNU long path and long link-target records from snapshot archives', async () => {
    const longTarget = `../${LONG_SEGMENT}/${LONG_SEGMENT}/${LONG_SEGMENT}/${LONG_SEGMENT}/target.js`;

    const tar = await gnuTar(
      { [LONG_PATH]: 'deep\n' },
      { 'src/link.js': longTarget },
    );

    const entries = await readArchive(tar);
    const byPath = new Map(entries.map((entry) => [entry.path.replace(/^\.\//, ''), entry]));

    expect(byPath.get(LONG_PATH)?.content.toString()).toBe('deep\n');
    expect(byPath.get('src/link.js')?.type).toBe('symlink');
    expect(byPath.get('src/link.js')?.linkPath).toBe(longTarget);
  });

  it('retains modes, symlinks, additions, modifications and deletions', async () => {
    const tar = await gnuTar(
      { 'src/a.js': 'a\n', 'src/b.js': 'b\n' },
      { 'src/link.js': './a.js' },
    );

    const manifest = await manifestFromTar(tar);
    const link = manifest.get('src/link.js');
    const file = manifest.get('src/a.js');

    expect(link?.type).toBe('symlink');
    expect(link?.linkTarget).toBe('./a.js');
    expect(file?.type).toBe('file');
    expect((file?.mode ?? 0) & 0o777).toBe(0o644);

    const after = await gnuTar({ 'src/a.js': 'changed\n', 'src/c.js': 'c\n' });
    const changes = await sourceDiff(tar, after);

    expect(changes.map((change) => `${change.kind} ${change.path}`).sort()).toEqual([
      'added src/c.js',
      'deleted src/b.js',
      'deleted src/link.js',
      'modified src/a.js',
    ]);
  });

  it('fails closed on an unsupported entry type, naming the real path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-fifo-'));
    dirs.push(dir);

    await mkdir(join(dir, 'src'), { recursive: true });
    await execa('mkfifo', [join(dir, 'src', 'pipe')]);

    const { stdout } = await execa(
      'tar',
      ['--create', ...(await gnuFormat()), '--file', '-', '--directory', dir, '.'],
      { encoding: 'buffer', stripFinalNewline: false },
    );

    const failure = await readArchive(Buffer.from(stdout)).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('pipe');
  });

  it('fails closed on a truncated archive rather than reporting a short one', async () => {
    const tar = await gnuTar({ 'src/a.js': 'a'.repeat(4096) });
    expect((await readArchive(tar)).map((entry) => entry.path)).toContain('./src/a.js');

    // Cut mid-entry: the parser itself notices.
    await expect(readArchive(tar.subarray(0, 2048))).rejects.toThrow(ArchiveError);

    // Cut on a block boundary: the stream ends cleanly and the parser is content, so only the
    // missing end-of-archive marker distinguishes this from a complete, shorter archive.
    await expect(readArchive(tar.subarray(0, 1024))).rejects.toThrow(/truncated/);

    // And an archive whose entries are all intact but whose terminator was stripped is still
    // refused: tar pads to a 10 KiB blocking factor, so this has to remove every zero block.
    let end = tar.length;
    while (end >= 512 && tar.subarray(end - 512, end).every((byte) => byte === 0)) end -= 512;

    expect(end).toBeLessThan(tar.length);
    await expect(readArchive(tar.subarray(0, end))).rejects.toThrow(/truncated/);
  });
});
