/**
 * A provider policy is *files plus arguments*, not flags: for Codex the only channel for
 * policy delivery is a generated CODEX_HOME, so both halves must be materialized and hashed
 * together to describe what a run was actually governed by.
 */
export interface CompiledAgentPolicy {
  /** Relative path within the provider home → file content. */
  files: Record<string, string>;
  /** The container's fixed argument array (§16). */
  args: string[];
  /** Environment the invocation requires. */
  env: Record<string, string>;
  /** The provider CLI reads stdin when it is not a TTY, so it is never left open. */
  stdin: 'closed';
  /** Covers file content and argv together. */
  hash: string;
}

export type ProviderName = 'codex' | 'claude';

export interface AgentEvent {
  type: string;
  raw: Record<string, unknown>;
}

export interface UsageMetadata {
  model?: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
}

export interface NormalizedProviderUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}
