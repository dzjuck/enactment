import { createHash } from 'node:crypto';

import { HARNESS_VERSION } from '../config/pins.js';
import type { RuntimeImages } from '../docker/images.js';
import type { BaselineArtifact } from '../verify/baseline.js';
import type { GreenVerdict } from '../verify/green.js';
import type { RedVerdict } from '../verify/red.js';
import type { RuntimeCheckResult } from '../verify/runtime.js';

/** The `runtime` block of the DESIGN.md §20 execution manifest. */
export interface RuntimeSection {
  harness_version: string;
  codex_image_id: string;
  claude_image_id: string;
  verifier_image_id: string;
  reviewer_image_id: string;
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

export interface CodeBehaviorUsageSection {
  tests: UsageSection;
  implementation: UsageSection;
}

export interface BaselineManifestSection extends BaselineArtifact {
  digest: string;
}

export interface FrozenSetManifestSection {
  digest: string;
  paths: string[];
}

export interface CodeBehaviorEvidence {
  baseline: BaselineManifestSection;
  frozen: FrozenSetManifestSection;
  red: RedVerdict;
  green: GreenVerdict;
  usage: CodeBehaviorUsageSection;
}

export function baselineSection(baseline: BaselineArtifact): BaselineManifestSection {
  const digest = createHash('sha256').update(JSON.stringify(baseline)).digest('hex');
  return { ...baseline, digest: `sha256:${digest}` };
}

export function usageSection(usage: UsageSection): UsageSection {
  return {
    model: usage.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cached_input_tokens: usage.cached_input_tokens,
  };
}

/**
 * DESIGN.md §21 / M6: the runtime verdict, recorded beside the static one.
 *
 * `manifest.runtime` is already the image section, so this is a separate key rather than a
 * nested one: an attempt's evidence must not need to disambiguate two meanings of "runtime".
 */
export interface RuntimeCheckSection {
  status: RuntimeCheckResult['status'];
  stage?: RuntimeCheckResult['stage'];
  /** Present when the stage alone would not explain the verdict. */
  reason?: string;
  url: string;
  readiness_url: string;
  readiness_ms: number;
  start_command: string[];
  commands: { argv: string[]; exit_code: number; status: string; duration_ms: number }[];
  verifier_image_id: string;
  cleanup_error?: string;
}

export function runtimeCheckSection(result: RuntimeCheckResult): RuntimeCheckSection {
  return {
    status: result.status,
    stage: result.stage,
    reason: result.reason,
    url: result.url,
    readiness_url: result.readinessUrl,
    readiness_ms: result.readiness.durationMs,
    start_command: [...result.startCommand],
    commands: result.commands.map((command) => ({
      argv: [...command.argv],
      exit_code: command.exitCode,
      status: command.status,
      duration_ms: command.durationMs,
    })),
    verifier_image_id: result.verifierImage,
    cleanup_error: result.cleanupError,
  };
}

export interface NetworkPolicySection {
  allowed_hosts: string[];
  /**
   * The provider CLI version this list was discovered against; §7 makes the list
   * version-specific. Named for no provider in particular, because the attempt records
   * whichever one it ran — a Claude attempt reporting a `codex_version` is wrong evidence.
   */
  cli_version: string;
  network_policy_hash: string;
}

/** Both arguments are required: a default would let one provider inherit the other's. */
export function networkPolicySection(
  hosts: readonly string[],
  cliVersion: string,
): NetworkPolicySection {
  const allowed_hosts = [...hosts];
  const canonical = JSON.stringify({ allowed_hosts, cli_version: cliVersion });

  return {
    allowed_hosts,
    cli_version: cliVersion,
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
    codex_image_id: images.codex.id,
    claude_image_id: images.claude.id,
    verifier_image_id: images.verifier.id,
    reviewer_image_id: images.reviewer.id,
    setup_image_id: images.setup.id,
    proxy_image_id: images.proxy.id,
  };
}
