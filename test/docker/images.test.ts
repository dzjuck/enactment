import { beforeAll, describe, expect, it } from 'vitest';

import { CODEX_VERSION, IMAGE_PINS, IMAGE_ROLES } from '../../src/config/pins.js';
import { buildImage, resolveDigest } from '../../src/docker/images.js';
import { runInImage } from '../helpers/docker.js';

beforeAll(async () => {
  for (const role of IMAGE_ROLES) {
    await buildImage(role);
  }
});

describe('runtime images', () => {
  it('builds the agent image with the pinned Codex version', async () => {
    const result = await runInImage(IMAGE_PINS.agent.tag, ['codex', '--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(CODEX_VERSION);
  });

  it('builds a verifier image with no Codex binary and no provider auth path', async () => {
    const codex = await runInImage(IMAGE_PINS.verifier.tag, ['sh', '-c', 'command -v codex']);
    expect(codex.exitCode).not.toBe(0);

    const authPaths = await runInImage(IMAGE_PINS.verifier.tag, [
      'sh',
      '-c',
      'ls -d /home/agent/.codex /run/agent-auth 2>/dev/null',
    ]);
    expect(authPaths.stdout).toBe('');

    const authEnv = await runInImage(IMAGE_PINS.verifier.tag, [
      'sh',
      '-c',
      'env | grep -iE "codex|openai|api_key" || true',
    ]);
    expect(authEnv.stdout).toBe('');
  });

  it('builds a setup image containing the package manager', async () => {
    const result = await runInImage(IMAGE_PINS.setup.tag, ['npm', '--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each(IMAGE_ROLES)('runs %s as uid 1001 and gid 1001', async (role) => {
    const uid = await runInImage(IMAGE_PINS[role].tag, ['id', '-u']);
    const gid = await runInImage(IMAGE_PINS[role].tag, ['id', '-g']);

    expect(uid.stdout.trim()).toBe('1001');
    expect(gid.stdout.trim()).toBe('1001');
  });

  it.each(IMAGE_ROLES)('resolves a sha256 digest for %s', async (role) => {
    await expect(resolveDigest(IMAGE_PINS[role].tag)).resolves.toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
