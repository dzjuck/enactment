import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createRedactor } from '../../artifacts/redact.js';
import { authMount, createAuthVolume } from '../../auth/volume.js';
import type { Mount } from '../../docker/args.js';
import type { RuntimeImages } from '../../docker/images.js';
import { runContainer } from '../../docker/run.js';
import { attemptLabels } from '../../volume/naming.js';
import { removeVolume } from '../../volume/workspace.js';
import {
  evaluateClaudeResult,
  parseClaudeEvents,
  type ClaudeEvaluation,
  type ClaudeEvent,
} from './events.js';
import { buildClaudeSpec, compileClaudePolicy, type ClaudePolicyMode } from './policy.js';

export const CLAUDE_PROMPT_ARTIFACT = 'prompt.txt';
export const CLAUDE_EVENTS_ARTIFACT = 'claude-events.jsonl';
export const CLAUDE_STDOUT_ARTIFACT = 'claude-stdout.log';
export const CLAUDE_STDERR_ARTIFACT = 'claude-stderr.log';

export interface ClaudeRunOptions {
  mode: ClaudePolicyMode;
  prompt: string;
  model: string;
  effort: string;
  network: string;
  env: Record<string, string>;
  mounts: Mount[];
  timeoutSeconds: number;
  graceSeconds: number;
  artifactDir: string;
  images: RuntimeImages;
  labels?: Record<string, string>;
  secrets?: readonly string[];
}

export type ClaudeRunResult =
  | (ClaudeEvaluation & {
      exitCode: number;
      events: ClaudeEvent[];
      stdout: string;
      stderr: string;
    })
  | {
      status: 'timeout';
      provider: 'claude';
      requested_model: string;
      reported_model: null;
      text: '';
      duration_ms: number;
      usage: {
        input_tokens: 0;
        output_tokens: 0;
        cache_read_input_tokens: 0;
        cache_creation_input_tokens: 0;
      };
      exitCode: number;
      events: [];
      stdout: string;
      stderr: string;
    };

export async function runClaudeAgent(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const redact = createRedactor(options.secrets ?? []);
  const policy = compileClaudePolicy(options);

  await mkdir(options.artifactDir, { recursive: true });
  await writeFile(join(options.artifactDir, CLAUDE_PROMPT_ARTIFACT), redact(options.prompt));

  const result = await runContainer(
    buildClaudeSpec({
      policy,
      images: options.images,
      network: options.network,
      env: options.env,
      mounts: options.mounts,
      ...(options.labels === undefined ? {} : { labels: options.labels }),
    }),
    { timeoutSeconds: options.timeoutSeconds, graceSeconds: options.graceSeconds },
  );

  await Promise.all([
    writeFile(join(options.artifactDir, CLAUDE_STDOUT_ARTIFACT), redact(result.stdout)),
    writeFile(join(options.artifactDir, CLAUDE_STDERR_ARTIFACT), redact(result.stderr)),
  ]);

  if (result.status === 'timeout') {
    return {
      status: 'timeout',
      provider: 'claude',
      requested_model: options.model,
      reported_model: null,
      text: '',
      duration_ms: result.durationMs,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      exitCode: result.exitCode,
      events: [],
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  const events = parseClaudeEvents(result.stdout);
  await writeFile(
    join(options.artifactDir, CLAUDE_EVENTS_ARTIFACT),
    redact(events.map((event) => JSON.stringify(event.raw)).join('\n')),
  );
  const evaluation = evaluateClaudeResult(events, {
    exitCode: result.exitCode,
    requestedModel: options.model,
  });

  return {
    ...evaluation,
    exitCode: result.exitCode,
    events,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export interface AuthenticatedClaudeRunOptions extends ClaudeRunOptions {
  attempt: string;
  token: string;
}

export async function runAuthenticatedClaudeAgent(
  options: AuthenticatedClaudeRunOptions,
): Promise<ClaudeRunResult> {
  const volume = await createAuthVolume(
    options.attempt,
    { provider: 'claude', token: options.token },
    options.images,
  );

  try {
    return await runClaudeAgent({
      mode: options.mode,
      prompt: options.prompt,
      model: options.model,
      effort: options.effort,
      network: options.network,
      env: options.env,
      mounts: [...options.mounts, authMount('claude', volume)],
      timeoutSeconds: options.timeoutSeconds,
      graceSeconds: options.graceSeconds,
      artifactDir: options.artifactDir,
      images: options.images,
      labels: options.labels ?? attemptLabels(options.attempt, 'claude-agent'),
      secrets: [...(options.secrets ?? []), options.token],
    });
  } finally {
    await removeVolume(volume);
  }
}
