import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ClaudeTokenError,
  claudeTokenPath,
  claudeTokenSecrets,
  loadClaudeToken,
} from '../../src/auth/claude-token.js';

const TOKEN = 'sk-ant-oat01-static-token-canary';
const dirs: string[] = [];

afterEach(async () => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tokenFile(content = TOKEN): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'enactment-claude-token-'));
  dirs.push(root);
  const directory = join(root, 'auth', 'claude');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = join(directory, 'token');
  await writeFile(file, content, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

describe('static Claude token store', () => {
  it('loads the manually provisioned file without importing an environment token or writing', async () => {
    const file = await tokenFile();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'environment-token-must-be-ignored';
    const before = await readFile(file);

    await expect(loadClaudeToken(file)).resolves.toBe(TOKEN);
    expect(await readFile(file)).toEqual(before);
  });

  it('uses the documented path under the harness state directory', () => {
    expect(claudeTokenPath('/state')).toBe('/state/auth/claude/token');
  });

  it.each([
    ['missing', undefined],
    ['blank', '  \n'],
  ])('reports an actionable %s token without exposing content', async (_label, content) => {
    let file: string;
    if (content === undefined) {
      const root = await mkdtemp(join(tmpdir(), 'enactment-claude-missing-'));
      dirs.push(root);
      file = join(root, 'missing-token');
    } else {
      file = await tokenFile(content);
    }

    const error = await loadClaudeToken(file).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClaudeTokenError);
    expect((error as Error).message).toContain('claude setup-token');
    expect((error as Error).message).toContain(file);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it.each([
    ['directory', 0o755],
    ['file', 0o644],
  ])('rejects a non-private %s mode', async (target, mode) => {
    const file = await tokenFile();
    await chmod(target === 'directory' ? join(file, '..') : file, mode);

    await expect(loadClaudeToken(file)).rejects.toThrow(ClaudeTokenError);
    await expect(loadClaudeToken(file)).rejects.toThrow(target === 'directory' ? /0700/ : /0600/);
  });

  it('keeps the directory and file private and exposes the token for redaction', async () => {
    const file = await tokenFile();
    const token = await loadClaudeToken(file);

    expect((await stat(join(file, '..'))).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(claudeTokenSecrets(token)).toEqual([TOKEN]);
  });
});
