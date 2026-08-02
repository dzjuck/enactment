import { resolveRuntimeImages, type RuntimeImages } from '../../src/docker/images.js';

let resolved: Promise<RuntimeImages> | undefined;

/**
 * The production image set, resolved once per test process. Suites take their container
 * images from here for the same reason a run does: the IDs resolved at startup are the only
 * thing that may be executed, so a rebuilt tag cannot change what is running.
 */
export function runtimeImages(): Promise<RuntimeImages> {
  resolved ??= resolveRuntimeImages();
  return resolved;
}
