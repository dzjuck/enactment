import { HARNESS_VERSION, type ImageRole } from '../config/pins.js';

/** The `runtime` block of the DESIGN.md §20 execution manifest. */
export interface RuntimeSection {
  harness_version: string;
  agent_image_digest: string;
  verifier_image_digest: string;
  setup_image_digest: string;
  proxy_image_digest: string;
}

export function runtimeSection(digests: Record<ImageRole, string>): RuntimeSection {
  return {
    harness_version: HARNESS_VERSION,
    agent_image_digest: digests.agent,
    verifier_image_digest: digests.verifier,
    setup_image_digest: digests.setup,
    proxy_image_digest: digests.proxy,
  };
}
