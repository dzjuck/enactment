import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CompiledAgentPolicy } from '../types.js';

/**
 * CODEX_HOME holds both the generated `config.toml` and the harness's `auth.json`, which is
 * why DESIGN.md §5 mounts it read-write: Codex rewrites the credential file in place.
 */
export const CODEX_HOME_PATH = '/run/agent-auth';

export const DEFAULT_MODEL = 'gpt-5.6-luna';
export const DEFAULT_REASONING_EFFORT = 'medium';

export interface CodexPolicyOptions {
  prompt: string;
  workdir: string;
  model?: string;
  reasoningEffort?: string;
}

/**
 * Every key here was validated against `codex exec --strict-config` on the pinned version:
 * an unrecognized or deprecated key is an error, not a warning, so this list is empirical
 * rather than aspirational.
 */
function renderConfig(model: string, effort: string): string {
  return [
    `model = "${model}"`,
    `model_reasoning_effort = "${effort}"`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'web_search = "disabled"',
    'mcp_servers = {}',
    '',
    '[features]',
    'in_app_updates = false',
    'standalone_web_search = false',
    'browser_use = false',
    'browser_use_external = false',
    'browser_use_full_cdp_access = false',
    'in_app_browser = false',
    'enable_mcp_apps = false',
    '',
    '[otel]',
    'exporter = "none"',
    '',
  ].join('\n');
}

/**
 * Compile the §27 container contract. The flag set is not configurable:
 *
 * - `--dangerously-bypass-approvals-and-sandbox` is mandatory, because Bubblewrap cannot
 *   create a user namespace under `capabilities: []` with `no_new_privileges: true`. An
 *   invocation without it does not fall back to something safer; it simply fails.
 * - `--strict-config` goes on `exec`, which is the only subcommand that accepts it.
 * - `--ignore-user-config` is deliberately absent: it would discard the generated config.
 */
export function compileCodexPolicy(options: CodexPolicyOptions): CompiledAgentPolicy {
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;

  const files = { 'config.toml': renderConfig(model, effort) };
  const args = [
    'codex',
    'exec',
    '--strict-config',
    '--dangerously-bypass-approvals-and-sandbox',
    '--json',
    '--ephemeral',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--cd',
    options.workdir,
    '--model',
    model,
    options.prompt,
  ];

  const canonical = JSON.stringify({ files, args });

  return {
    files,
    args,
    env: { CODEX_HOME: CODEX_HOME_PATH },
    stdin: 'closed',
    hash: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
  };
}

/** Write the policy files into a directory that will be mounted as CODEX_HOME. */
export async function materializeCodexHome(
  policy: CompiledAgentPolicy,
  directory: string,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });

  for (const [name, content] of Object.entries(policy.files)) {
    const path = join(directory, name);
    await writeFile(path, content);
    await chmod(path, 0o600);
  }

  return directory;
}
