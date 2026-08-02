import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  BUILT_IMAGE_PINS,
  IMAGE_ROLES,
  SUPPORTED_PLATFORMS,
  type ImageRole,
} from '../../src/config/pins.js';
import {
  ImagePinError,
  resolveRuntimeImages,
  type RuntimeImages,
} from '../../src/docker/images.js';
import { runtimeSection } from '../../src/run/manifest.js';

const PLATFORM = 'linux/arm64';

/** What `docker image inspect --format '{{json .RootFS.Layers}}'` returns. */
const LAYERS: Record<ImageRole, string> = {
  agent: '["sha256:aaa","sha256:aab"]',
  verifier: '["sha256:bbb"]',
  setup: '["sha256:ccc"]',
  proxy: '["sha256:ddd"]',
};

const contentDigest = (layers: string): string =>
  `sha256:${createHash('sha256').update(layers).digest('hex')}`;

const DIGESTS = Object.fromEntries(
  IMAGE_ROLES.map((role) => [role, contentDigest(LAYERS[role])]),
) as Record<ImageRole, string>;

/** The image IDs the daemon would report; `{{.Id}}` is what a container is started from. */
const IDS = Object.fromEntries(
  IMAGE_ROLES.map((role, index) => [role, `sha256:${String(index + 1).repeat(64)}`]),
) as Record<ImageRole, string>;

const IMAGES = Object.fromEntries(
  IMAGE_ROLES.map((role) => [role, { role, reference: IDS[role], digest: DIGESTS[role] }]),
) as RuntimeImages;

/** Records every docker invocation so the tests can prove what was never attempted. */
function recordingExec(layers: Record<ImageRole, string>, platform = PLATFORM) {
  const calls: string[][] = [];

  const exec = async (args: string[]): Promise<string> => {
    calls.push(args);

    if (args[0] === 'version') return platform;

    const tag = args.at(-1) ?? '';
    const role = IMAGE_ROLES.find((candidate) => tag.includes(candidate));
    if (role === undefined) throw new Error(`unexpected docker invocation: ${args.join(' ')}`);
    return args.includes('{{.Id}}') ? IDS[role] : layers[role];
  };

  const containerCommands = (): string[][] =>
    calls.filter((args) => ['run', 'create', 'start', 'image'].includes(args[0] ?? ''));

  return { calls, exec, containerCommands };
}

describe('built-image pins', () => {
  it('declares non-empty digests for every role on every supported platform', () => {
    expect(SUPPORTED_PLATFORMS.length).toBeGreaterThan(0);

    for (const platform of SUPPORTED_PLATFORMS) {
      const pins = BUILT_IMAGE_PINS[platform];
      expect(pins).toBeDefined();

      for (const role of IMAGE_ROLES) {
        expect(pins?.[role]).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    }
  });

  it('pins image content, so a rebuild that changes nothing still matches', async () => {
    const { exec } = recordingExec(LAYERS);

    // Two resolutions of the same layer set agree, regardless of when the image was built.
    await expect(
      resolveRuntimeImages({ pins: DIGESTS, platform: PLATFORM, exec }),
    ).resolves.toEqual(IMAGES);
    await expect(
      resolveRuntimeImages({ pins: DIGESTS, platform: PLATFORM, exec }),
    ).resolves.toEqual(IMAGES);
  });

  it('treats a missing role digest as a configuration error before any container command', async () => {
    const { exec, containerCommands } = recordingExec(LAYERS);
    const incomplete = { ...DIGESTS } as Partial<Record<ImageRole, string>>;
    delete incomplete.verifier;

    const error = await resolveRuntimeImages({
      pins: incomplete as Record<ImageRole, string>,
      platform: PLATFORM,
      exec,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ImagePinError);
    expect((error as Error).message).toContain('verifier');
    expect(containerCommands()).toEqual([]);
  });

  it('stops on an unsupported Docker server platform, naming it', async () => {
    const { exec, containerCommands } = recordingExec(LAYERS, 'linux/riscv64');

    const error = await resolveRuntimeImages({ exec }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ImagePinError);
    expect((error as Error).message).toContain('linux/riscv64');
    expect(containerCommands()).toEqual([]);
  });

  it('rejects changed image content, before any container is started', async () => {
    const changed = { ...LAYERS, verifier: '["sha256:bbb","sha256:injected"]' };
    const { exec, calls } = recordingExec(changed);

    const error = await resolveRuntimeImages({
      pins: DIGESTS,
      platform: PLATFORM,
      exec,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ImagePinError);
    expect((error as Error).message).toContain('verifier');
    expect((error as Error).message).toContain(DIGESTS.verifier);
    expect((error as Error).message).toContain(contentDigest(changed.verifier));

    const attempted = calls.flat();
    expect(attempted).not.toContain('run');
    expect(attempted).not.toContain('create');
    expect(attempted).not.toContain('start');
  });
});

describe('runtimeSection', () => {
  it('records all four image digests', () => {
    expect(runtimeSection(IMAGES)).toEqual({
      harness_version: expect.any(String),
      agent_image_digest: DIGESTS.agent,
      verifier_image_digest: DIGESTS.verifier,
      setup_image_digest: DIGESTS.setup,
      proxy_image_digest: DIGESTS.proxy,
    });
  });
});
