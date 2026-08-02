import { resolveRuntimeImages, type RuntimeImages } from '../../src/docker/images.js';

let resolved: Promise<RuntimeImages> | undefined;

/**
 * The verified production image set, resolved once per test process. Suites take their
 * container references from here for the same reason a run does: the pinned set is the only
 * thing that may be executed.
 */
export function runtimeImages(): Promise<RuntimeImages> {
  resolved ??= resolveRuntimeImages();
  return resolved;
}
