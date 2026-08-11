import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  CLAUDE_EVENTS_ARTIFACT,
  CLAUDE_STDERR_ARTIFACT,
  CLAUDE_STDOUT_ARTIFACT,
  runClaudeAgent,
} from '../../src/adapters/claude/run.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { runtimeImages } from '../helpers/images.js';
import { cannedClaudeEvents, stubClaudeImage } from '../helpers/stub-agent.js';

const dirs: string[] = [];
let images: RuntimeImages;

beforeAll(async () => {
  const production = await runtimeImages();
  images = { ...production, claude: await stubClaudeImage() };
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function artifacts(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'enactment-claude-run-'));
  dirs.push(dir);
  return dir;
}

describe('Claude stub run', () => {
  it('redacts prompt, event, stdout, and stderr artifacts', async () => {
    const secret = 'claude-secret-canary';
    const artifactDir = await artifacts();
    const result = await runClaudeAgent({
      mode: 'coding',
      prompt: `Implement slugify without exposing ${secret}`,
      model: 'claude-sonnet-5',
      effort: 'medium',
      network: 'none',
      env: {
        STUB_CLAUDE_MODE: 'events',
        STUB_CLAUDE_EVENTS: cannedClaudeEvents(secret),
        STUB_CLAUDE_STDERR: `stderr ${secret}`,
      },
      mounts: [],
      timeoutSeconds: 30,
      graceSeconds: 2,
      artifactDir,
      images,
      secrets: [secret],
    });

    expect(result.status).toBe('completed');
    for (const name of [
      'prompt.txt',
      CLAUDE_EVENTS_ARTIFACT,
      CLAUDE_STDOUT_ARTIFACT,
      CLAUDE_STDERR_ARTIFACT,
    ]) {
      const content = await readFile(join(artifactDir, name), 'utf8');
      expect(content).not.toContain(secret);
      expect(content).toContain('[redacted]');
    }
  });

  it('terminates a hanging Claude command through the shared timeout ladder', async () => {
    const result = await runClaudeAgent({
      mode: 'coding',
      prompt: 'Hang.',
      model: 'claude-sonnet-5',
      effort: 'medium',
      network: 'none',
      env: { STUB_CLAUDE_MODE: 'hang' },
      mounts: [],
      timeoutSeconds: 2,
      graceSeconds: 1,
      artifactDir: await artifacts(),
      images,
    });

    expect(result.status).toBe('timeout');
  });
});
