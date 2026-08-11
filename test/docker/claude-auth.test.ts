import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CLAUDE_AUTH_PATH } from '../../src/adapters/claude/policy.js';
import { runAuthenticatedClaudeAgent } from '../../src/adapters/claude/run.js';
import { loadClaudeToken } from '../../src/auth/claude-token.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { authVolumeName, newAttemptId } from '../../src/volume/naming.js';
import { volumeExists } from '../../src/volume/workspace.js';
import { listContainers } from '../helpers/docker.js';
import { runtimeImages } from '../helpers/images.js';
import { cannedClaudeEvents, stubClaudeImage } from '../helpers/stub-agent.js';

const TOKEN = 'sk-ant-oat01-docker-token-canary';
const dirs: string[] = [];
let images: RuntimeImages;

beforeAll(async () => {
  const production = await runtimeImages();
  images = { ...production, claude: await stubClaudeImage() };
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function storedToken(): Promise<{ file: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), 'enactment-claude-auth-'));
  dirs.push(root);
  const directory = join(root, 'auth', 'claude');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = join(directory, 'token');
  await writeFile(file, TOKEN, { mode: 0o600 });
  return { file, token: await loadClaudeToken(file) };
}

/**
 * A budget generous enough that a loaded daemon cannot turn a completed run into a timeout.
 * It is a ceiling, not a wait: only the cases that deliberately hang ever reach it.
 */
const COMPLETES_SECONDS = 60;
const HANGS_SECONDS = 2;

function run(
  attempt: string,
  token: string,
  mode: string,
  events = cannedClaudeEvents(),
  timeoutSeconds = COMPLETES_SECONDS,
) {
  return runAuthenticatedClaudeAgent({
    attempt,
    token,
    mode: 'coding',
    prompt: 'Implement slugify.',
    model: 'claude-sonnet-5',
    effort: 'medium',
    network: 'none',
    env: { STUB_CLAUDE_MODE: mode, STUB_CLAUDE_EVENTS: events },
    mounts: [],
    timeoutSeconds,
    graceSeconds: 1,
    artifactDir: join(dirs[0] ?? tmpdir(), `artifacts-${attempt}`),
    images,
  });
}

describe('authenticated Claude adapter', () => {
  it('loads the token through the fixed launcher without exposing it in Docker metadata', async () => {
    const { token } = await storedToken();
    const attempt = newAttemptId();
    const pending = run(attempt, token, 'hang', cannedClaudeEvents(), HANGS_SECONDS);

    let containers: string[] = [];
    for (let count = 0; count < 30 && containers.length === 0; count += 1) {
      containers = await listContainers(`enactment.attempt=${attempt}`);
      if (containers.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(containers).toHaveLength(1);
    const { stdout } = await execa('docker', ['inspect', containers[0] ?? 'missing']);
    expect(stdout).toContain(CLAUDE_AUTH_PATH);
    expect(stdout).not.toContain(TOKEN);
    expect(stdout).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    await expect(pending).resolves.toMatchObject({ status: 'timeout' });
  });

  it.each([
    ['success', 'events', cannedClaudeEvents(), 'completed', COMPLETES_SECONDS],
    ['failure', 'provider-error', '', 'failed', COMPLETES_SECONDS],
    // The only row that spends its budget, so it is the only one that keeps a short one.
    ['timeout', 'hang', '', 'timeout', HANGS_SECONDS],
    ['parse error', 'events', 'not-json', 'throws', COMPLETES_SECONDS],
  ])('deletes the auth volume after %s', async (_label, mode, events, expected, seconds) => {
    const { file, token } = await storedToken();
    const before = await readFile(file);
    const attempt = newAttemptId();
    const outcome = await run(attempt, token, mode, events, seconds).catch(
      (cause: unknown) => cause,
    );

    if (expected === 'throws') expect(outcome).toBeInstanceOf(Error);
    else expect(outcome).toMatchObject({ status: expected });
    if (_label === 'success') {
      expect(outcome).toMatchObject({
        provider: 'claude',
        requested_model: 'claude-sonnet-5',
        reported_model: 'claude-sonnet-5',
        text: expect.stringContaining('Implemented slugify.'),
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      });
    }
    await expect(volumeExists(authVolumeName('claude', attempt))).resolves.toBe(false);
    expect(await readFile(file)).toEqual(before);
  });
});
