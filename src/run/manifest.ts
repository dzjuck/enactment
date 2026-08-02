import { createHash } from 'node:crypto';

import { CODEX_VERSION, HARNESS_VERSION, PROVIDER_ALLOWLIST } from '../config/pins.js';
import type { RuntimeImages } from '../docker/images.js';

/** The `runtime` block of the DESIGN.md §20 execution manifest. */
export interface RuntimeSection {
  harness_version: string;
  agent_image_id: string;
  verifier_image_id: string;
  setup_image_id: string;
  proxy_image_id: string;
}

/** DESIGN.md §33: usage is recorded per run so cost and routing can be reasoned about. */
export interface UsageSection {
  model?: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
}

export function usageSection(usage: UsageSection): UsageSection {
  return {
    model: usage.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cached_input_tokens: usage.cached_input_tokens,
  };
}

export interface NetworkPolicySection {
  allowed_hosts: string[];
  /** The version the list was discovered against; §7 makes the list version-specific. */
  codex_version: string;
  network_policy_hash: string;
}

export function networkPolicySection(
  hosts: readonly string[] = PROVIDER_ALLOWLIST,
  codexVersion: string = CODEX_VERSION,
): NetworkPolicySection {
  const allowed_hosts = [...hosts];
  const canonical = JSON.stringify({ allowed_hosts, codex_version: codexVersion });

  return {
    allowed_hosts,
    codex_version: codexVersion,
    network_policy_hash: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
  };
}

/**
 * Built from the same `RuntimeImages` value the phases ran, so the manifest cannot record an
 * image set that differs from the executed one.
 */
export function runtimeSection(images: RuntimeImages): RuntimeSection {
  return {
    harness_version: HARNESS_VERSION,
    agent_image_id: images.agent.id,
    verifier_image_id: images.verifier.id,
    setup_image_id: images.setup.id,
    proxy_image_id: images.proxy.id,
  };
}
