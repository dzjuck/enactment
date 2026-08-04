import type { AgentEvent, UsageMetadata } from '../types.js';

export type { AgentEvent, UsageMetadata } from '../types.js';

export class EventParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventParseError';
  }
}

/**
 * Parse the provider's JSONL stream.
 *
 * Deliberately permissive about event *shape* and strict about event *framing*: a new event
 * type from a provider upgrade must not break a run, but an unparseable line is an error
 * rather than a silently dropped one — a truncated stream would otherwise look like a short
 * but successful run.
 */
export function parseEvents(jsonl: string): AgentEvent[] {
  const events: AgentEvent[] = [];

  jsonl.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new EventParseError(`malformed agent event on line ${String(index + 1)}`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new EventParseError(`agent event on line ${String(index + 1)} is not an object`);
    }

    const raw = parsed as Record<string, unknown>;
    if (typeof raw.type !== 'string') {
      throw new EventParseError(`agent event on line ${String(index + 1)} has no type`);
    }

    events.push({ type: raw.type, raw });
  });

  return events;
}

function numberAt(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Usage is read from wherever the provider reports it rather than from one pinned event
 * type, so a rename upstream degrades to zeros instead of throwing mid-run. The live suite
 * is what confirms the real shape.
 */
export function extractUsage(events: AgentEvent[]): UsageMetadata {
  const usage: UsageMetadata = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };

  for (const event of events) {
    const model = event.raw.model;
    if (typeof model === 'string') usage.model = model;

    const reported = event.raw.usage;
    if (typeof reported !== 'object' || reported === null) continue;

    const fields = reported as Record<string, unknown>;
    usage.input_tokens = numberAt(fields, 'input_tokens') ?? usage.input_tokens;
    usage.output_tokens = numberAt(fields, 'output_tokens') ?? usage.output_tokens;
    usage.cached_input_tokens = numberAt(fields, 'cached_input_tokens') ?? usage.cached_input_tokens;
  }

  return usage;
}
