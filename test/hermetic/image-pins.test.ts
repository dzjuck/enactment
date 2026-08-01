import { describe, expect, it } from 'vitest';

import { IMAGE_PINS, IMAGE_ROLES, type ImagePin, type ImageRole } from '../../src/config/pins.js';
import { ImagePinError, resolveImageDigests } from '../../src/docker/images.js';
import { runtimeSection } from '../../src/run/manifest.js';

const DIGESTS: Record<ImageRole, string> = {
  agent: `sha256:${'a'.repeat(64)}`,
  verifier: `sha256:${'b'.repeat(64)}`,
  setup: `sha256:${'c'.repeat(64)}`,
  proxy: `sha256:${'d'.repeat(64)}`,
};

function pinnedTo(digests: Record<ImageRole, string>): Record<ImageRole, ImagePin> {
  const pins = {} as Record<ImageRole, ImagePin>;
  for (const role of IMAGE_ROLES) {
    pins[role] = { ...IMAGE_PINS[role], digest: digests[role] };
  }
  return pins;
}

/** Records every docker invocation so the tests can prove what was never attempted. */
function recordingExec(digests: Record<ImageRole, string>) {
  const calls: string[][] = [];
  const byTag = new Map(IMAGE_ROLES.map((role) => [IMAGE_PINS[role].tag, digests[role]]));

  const exec = async (args: string[]): Promise<string> => {
    calls.push(args);
    const tag = args.at(-1) ?? '';
    const digest = byTag.get(tag);
    if (digest === undefined) throw new Error(`unexpected docker invocation: ${args.join(' ')}`);
    return digest;
  };

  return { calls, exec };
}

describe('resolveImageDigests', () => {
  it('returns the resolved digest of every image when the pins match', async () => {
    const { exec } = recordingExec(DIGESTS);

    await expect(resolveImageDigests({ pins: pinnedTo(DIGESTS), exec })).resolves.toEqual(DIGESTS);
  });

  it('rejects a resolved digest that differs from the pin, without starting a container', async () => {
    const resolved = { ...DIGESTS, verifier: `sha256:${'e'.repeat(64)}` };
    const { calls, exec } = recordingExec(resolved);

    const error = await resolveImageDigests({ pins: pinnedTo(DIGESTS), exec }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ImagePinError);
    expect((error as Error).message).toContain('verifier');
    expect((error as Error).message).toContain(DIGESTS.verifier);
    expect((error as Error).message).toContain(resolved.verifier);

    const attempted = calls.flat();
    expect(attempted).not.toContain('run');
    expect(attempted).not.toContain('create');
    expect(attempted).not.toContain('start');
  });
});

describe('runtimeSection', () => {
  it('records all four image digests', () => {
    expect(runtimeSection(DIGESTS)).toEqual({
      harness_version: expect.any(String),
      agent_image_digest: DIGESTS.agent,
      verifier_image_digest: DIGESTS.verifier,
      setup_image_digest: DIGESTS.setup,
      proxy_image_digest: DIGESTS.proxy,
    });
  });
});
