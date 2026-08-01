import { createHash } from 'node:crypto';

import {
  CODEX_VERSION,
  HARNESS_VERSION,
  PROVIDER_ALLOWLIST,
  type ImageRole,
} from '../config/pins.js';

/** The `runtime` block of the DESIGN.md §20 execution manifest. */
export interface RuntimeSection {
  harness_version: string;
  agent_image_digest: string;
  verifier_image_digest: string;
  setup_image_digest: string;
  proxy_image_digest: string;
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

export function runtimeSection(digests: Record<ImageRole, string>): RuntimeSection {
  return {
    harness_version: HARNESS_VERSION,
    agent_image_digest: digests.agent,
    verifier_image_digest: digests.verifier,
    setup_image_digest: digests.setup,
    proxy_image_digest: digests.proxy,
  };
}
