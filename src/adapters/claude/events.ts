import type { AgentEvent, NormalizedProviderUsage } from '../types.js';

export class ClaudeEventParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeEventParseError';
  }
}

export type ClaudeEvent = AgentEvent;

export function parseClaudeEvents(jsonl: string): ClaudeEvent[] {
  const events: ClaudeEvent[] = [];

  jsonl.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ClaudeEventParseError(`malformed Claude event on line ${String(index + 1)}`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ClaudeEventParseError(`Claude event on line ${String(index + 1)} is not an object`);
    }

    const raw = parsed as Record<string, unknown>;
    if (typeof raw.type !== 'string') {
      throw new ClaudeEventParseError(`Claude event on line ${String(index + 1)} has no type`);
    }
    events.push({ type: raw.type, raw });
  });

  return events;
}

export type ClaudeFailureCategory = 'provider_error' | 'agent_failed';

export interface ClaudeEvaluation {
  status: 'completed' | 'failed';
  provider: 'claude';
  requested_model: string;
  reported_model: string | null;
  text: string;
  duration_ms: number;
  usage: NormalizedProviderUsage;
  failure_category?: ClaudeFailureCategory;
}

function numberAt(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' ? value : 0;
}

function usageFrom(raw: Record<string, unknown>): NormalizedProviderUsage {
  const value = raw.usage;
  const usage = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    input_tokens: numberAt(usage, 'input_tokens'),
    output_tokens: numberAt(usage, 'output_tokens'),
    cache_read_input_tokens: numberAt(usage, 'cache_read_input_tokens'),
    cache_creation_input_tokens: numberAt(usage, 'cache_creation_input_tokens'),
  };
}

function reportedModel(events: ClaudeEvent[]): string | null {
  for (const event of events) {
    if (event.type !== 'system' || event.raw.subtype !== 'init') continue;
    if (typeof event.raw.model === 'string') return event.raw.model;
  }
  return null;
}

export function evaluateClaudeResult(
  events: ClaudeEvent[],
  options: { exitCode: number; requestedModel: string },
): ClaudeEvaluation {
  const last = events.at(-1);
  const terminal = last?.type === 'result' ? last.raw : undefined;
  const model = reportedModel(events);
  const text = typeof terminal?.result === 'string' ? terminal.result : '';
  const duration = typeof terminal?.duration_ms === 'number' ? terminal.duration_ms : 0;
  const usage = terminal === undefined ? usageFrom({}) : usageFrom(terminal);

  const common = {
    provider: 'claude' as const,
    requested_model: options.requestedModel,
    reported_model: model,
    text,
    duration_ms: duration,
    usage,
  };

  const providerError =
    terminal?.is_error === true &&
    terminal.terminal_reason === 'api_error' &&
    typeof terminal.api_error_status === 'number';
  if (providerError) {
    return { ...common, status: 'failed', failure_category: 'provider_error' };
  }

  const completed =
    terminal !== undefined &&
    terminal.subtype === 'success' &&
    terminal.is_error === false &&
    options.exitCode === 0 &&
    text.trim() !== '' &&
    model !== null &&
    model === options.requestedModel;

  return completed
    ? { ...common, status: 'completed' }
    : { ...common, status: 'failed', failure_category: 'agent_failed' };
}
