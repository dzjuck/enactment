import { IMAGE_PINS, IMAGE_ROLES } from './config/pins.js';
import { buildAllImages, resolveImageId } from './docker/images.js';

/**
 * The operator entry point: build the five runtime images this harness runs its phases in.
 *
 * A run resolves these tags to image IDs at startup and refuses to start without them, so
 * this is a prerequisite of every run rather than a test-suite side effect.
 */
await buildAllImages();

for (const role of IMAGE_ROLES) {
  const tag = IMAGE_PINS[role].tag;
  process.stdout.write(`${role.padEnd(8)} ${tag}  ${await resolveImageId(tag)}\n`);
}
