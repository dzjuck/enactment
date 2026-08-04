import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_AUTH_PATH } from '../../src/adapters/claude/policy.js';
import {
  authMount,
  seedClaudeAuthVolume,
} from '../../src/auth/volume.js';
import { IMAGE_ROLES } from '../../src/config/pins.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { authVolumeName } from '../../src/volume/naming.js';

const TOKEN = 'claude-volume-token-canary';

const { calls, fakeExeca } = vi.hoisted(() => {
  const recorded: Array<{ args: string[]; input?: Buffer }> = [];
  const fake = (
    _file: string,
    args: string[],
    options?: { input?: Buffer },
  ): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> => {
    recorded.push({ args, ...(options?.input === undefined ? {} : { input: options.input }) });
    return Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  };
  return { calls: recorded, fakeExeca: fake };
});

vi.mock('execa', () => ({ execa: fakeExeca }));

const IMAGES = Object.fromEntries(
  IMAGE_ROLES.map((role, index) => [
    role,
    { role, id: `sha256:${String(index + 1).repeat(64)}` },
  ]),
) as RuntimeImages;

describe('provider-scoped auth volumes', () => {
  it('uses distinct provider suffixes and mount targets', () => {
    expect(authVolumeName('codex', 'attempt')).toBe('ai-harness-auth-attempt-codex');
    expect(authVolumeName('claude', 'attempt')).toBe('ai-harness-auth-attempt-claude');
    expect(authMount('claude', 'claude-volume')).toEqual({
      type: 'volume',
      source: 'claude-volume',
      target: CLAUDE_AUTH_PATH,
    });
  });

  it('seeds the Claude token on stdin with no secret in Docker argv or environment', async () => {
    calls.length = 0;
    await seedClaudeAuthVolume('claude-volume', TOKEN, IMAGES);

    const run = calls.find((call) => call.args[0] === 'run');
    expect(run?.input?.toString('utf8')).toBe(TOKEN);
    expect(JSON.stringify(run?.args)).toContain(`${CLAUDE_AUTH_PATH}/token`);
    expect(JSON.stringify(run?.args)).not.toContain(TOKEN);
    expect(run?.args).toContain(IMAGES.claude.id);
  });
});
