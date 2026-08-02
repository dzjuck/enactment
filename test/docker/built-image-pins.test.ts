import { describe, expect, it } from 'vitest';

import { BUILT_IMAGE_PINS, IMAGE_PINS, IMAGE_ROLES } from '../../src/config/pins.js';
import {
  buildImage,
  resolveDockerPlatform,
  resolveRuntimeImages,
} from '../../src/docker/images.js';

describe('committed built-image pins', () => {
  it('match the images built on this platform', async () => {
    const platform = await resolveDockerPlatform();
    const pins = BUILT_IMAGE_PINS[platform];

    expect(pins, `no committed pins for ${platform}`).toBeDefined();

    const resolved = await resolveRuntimeImages();

    for (const role of IMAGE_ROLES) {
      expect(resolved[role].digest, `${role} (${IMAGE_PINS[role].tag})`).toBe(pins?.[role]);
    }
  }, 120_000);

  it('survive a rebuild that changes nothing', async () => {
    const before = await resolveRuntimeImages();

    await buildImage('verifier');

    // The pin follows image content, not the moment the image was built.
    const after = await resolveRuntimeImages();
    for (const role of IMAGE_ROLES) expect(after[role].digest).toBe(before[role].digest);
  }, 300_000);
});
