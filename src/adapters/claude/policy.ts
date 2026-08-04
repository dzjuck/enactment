import { createHash } from 'node:crypto';

import type { ContainerSpec, Mount } from '../../docker/args.js';
import type { RuntimeImages } from '../../docker/images.js';
import type { CompiledAgentPolicy } from '../types.js';

/** Constants proven against Claude Code 2.1.221 by the Milestone 4 feasibility gate. */
export const CLAUDE_AUTH_PATH = '/run/claude-auth';
export const CLAUDE_LAUNCHER = 'claude-from-token';
export const CLAUDE_PRINT_FLAG = '-p';

export const CLAUDE_BASE_ARGS: readonly string[] = [
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--safe-mode',
  '--no-chrome',
];

export const CLAUDE_CODING_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash',
];

/** One permission control only; the outer Docker container is the security boundary. */
export const CLAUDE_CODING_PERMISSION_ARGS: readonly string[] = [
  '--permission-mode',
  'bypassPermissions',
];

/**
 * `--safe-mode` suppresses workspace CLAUDE.md and customizations. The init event still
 * advertises built-in skill/agent metadata, but neither is callable unless its tool is present;
 * coding exposes only CLAUDE_CODING_TOOLS and diagnosis exposes no tools.
 */
export const CLAUDE_DIAGNOSIS_TOOLS = '';

export type ClaudePolicyMode = 'coding' | 'diagnosis';

export interface ClaudePolicyOptions {
  mode: ClaudePolicyMode;
  prompt: string;
  model: string;
  effort: string;
}

export interface CompiledClaudePolicy extends CompiledAgentPolicy {
  mode: ClaudePolicyMode;
  model: string;
  effort: string;
}

export function hashClaudePolicy(policy: CompiledClaudePolicy): string {
  const canonical = JSON.stringify({
    files: policy.files,
    args: policy.args,
    env: policy.env,
    stdin: policy.stdin,
    mode: policy.mode,
    model: policy.model,
    effort: policy.effort,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function compileClaudePolicy(options: ClaudePolicyOptions): CompiledClaudePolicy {
  const tools =
    options.mode === 'coding' ? CLAUDE_CODING_TOOLS.join(',') : CLAUDE_DIAGNOSIS_TOOLS;
  const permissionArgs =
    options.mode === 'coding' ? [...CLAUDE_CODING_PERMISSION_ARGS] : [];
  const policy: CompiledClaudePolicy = {
    mode: options.mode,
    model: options.model,
    effort: options.effort,
    files: {},
    args: [
      CLAUDE_LAUNCHER,
      CLAUDE_PRINT_FLAG,
      options.prompt,
      ...CLAUDE_BASE_ARGS,
      '--tools',
      tools,
      ...permissionArgs,
      '--model',
      options.model,
      '--effort',
      options.effort,
    ],
    env: {},
    stdin: 'closed',
    hash: '',
  };
  policy.hash = hashClaudePolicy(policy);
  return policy;
}

export interface ClaudeSpecOptions {
  policy: CompiledClaudePolicy;
  images: RuntimeImages;
  network: string;
  env: Record<string, string>;
  mounts: Mount[];
  labels?: Record<string, string>;
}

export function buildClaudeSpec(options: ClaudeSpecOptions): ContainerSpec {
  return {
    image: options.images.claude.id,
    argv: options.policy.args,
    network: options.network,
    workdir: options.policy.mode === 'coding' ? '/workspace' : '/home/agent',
    env: { ...options.env, ...options.policy.env },
    mounts: options.mounts,
    ...(options.labels === undefined ? {} : { labels: options.labels }),
  };
}
