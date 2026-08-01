import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createRedactor } from '../../artifacts/redact.js';
import { IMAGE_PINS } from '../../config/pins.js';
import type { ContainerSpec, Mount } from '../../docker/args.js';
import { runContainer } from '../../docker/run.js';
import type { CompiledAgentPolicy } from '../types.js';
import { extractUsage, parseEvents, type AgentEvent, type UsageMetadata } from './events.js';
import { compileCodexPolicy } from './policy.js';

export type AgentStatus = 'completed' | 'failed' | 'timeout';

export interface AgentRunOptions {
  prompt: string;
  network: string;
  env: Record<string, string>;
  mounts: Mount[];
  timeoutSeconds: number;
  graceSeconds: number;
  artifactDir: string;
  image?: string;
  workdir?: string;
  policy?: CompiledAgentPolicy;
  secrets?: readonly string[];
  /** Restore the pre-invocation workspace snapshot; §5 runs this before the failure lands. */
  onTimeout?: () => Promise<void>;
}

export interface AgentRunResult {
  status: AgentStatus;
  exitCode: number;
  events: AgentEvent[];
  usage: UsageMetadata;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export const PROMPT_ARTIFACT = 'prompt.txt';
export const EVENTS_ARTIFACT = 'agent-events.jsonl';

function policyFor(options: AgentRunOptions): CompiledAgentPolicy {
  return (
    options.policy ??
    compileCodexPolicy({ prompt: options.prompt, workdir: options.workdir ?? '/workspace' })
  );
}

/**
 * The agent container, as a value. Everything the container is allowed to see is declared
 * here and nowhere else, so the mount list is a testable property rather than a side effect
 * of the call site.
 */
export function buildAgentSpec(options: AgentRunOptions): ContainerSpec {
  const policy = policyFor(options);

  return {
    image: options.image ?? IMAGE_PINS.agent.tag,
    argv: policy.args,
    network: options.network,
    workdir: options.workdir ?? '/workspace',
    env: { ...policy.env, ...options.env },
    mounts: options.mounts,
    // No stdin: Codex reads it when it is not a TTY and would wait for input that never comes.
  };
}

/**
 * Run Codex in the agent container and produce a redacted event log, usage metadata and a
 * terminal status. Termination is delegated to the §5 ladder inside `runContainer` rather
 * than reimplemented here.
 */
export async function runCodexAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const redact = createRedactor(options.secrets ?? []);

  await mkdir(options.artifactDir, { recursive: true });
  await writeFile(join(options.artifactDir, PROMPT_ARTIFACT), options.prompt);

  const result = await runContainer(buildAgentSpec(options), {
    timeoutSeconds: options.timeoutSeconds,
    graceSeconds: options.graceSeconds,
  });

  if (result.status === 'timeout') {
    await options.onTimeout?.();

    return {
      status: 'timeout',
      exitCode: result.exitCode,
      events: [],
      usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    };
  }

  // Parsed before the exit code is judged: a failing run's events are still evidence.
  const events = parseEvents(result.stdout);
  await writeFile(
    join(options.artifactDir, EVENTS_ARTIFACT),
    redact(events.map((event) => JSON.stringify(event.raw)).join('\n')),
  );

  return {
    status: result.exitCode === 0 ? 'completed' : 'failed',
    exitCode: result.exitCode,
    events,
    usage: extractUsage(events),
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}
