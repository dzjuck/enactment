import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ClaudeEventParseError,
  evaluateClaudeResult,
  parseClaudeEvents,
} from '../../src/adapters/claude/events.js';
import { FAILURE_CATEGORIES } from '../../src/run/failure.js';

const fixture = fileURLToPath(
  new URL('../../fixtures/claude-events/success.jsonl', import.meta.url),
);

const resultEvent = (overrides: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done.',
  duration_ms: 25,
  usage: {
    input_tokens: 10,
    output_tokens: 4,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
  },
  ...overrides,
});

const jsonl = (...events: Record<string, unknown>[]): string =>
  events.map((event) => JSON.stringify(event)).join('\n');

const init = (model = 'claude-sonnet-5') => ({ type: 'system', subtype: 'init', model });

describe('Claude event framing', () => {
  it('preserves recorded events in order, including unknown object event types', async () => {
    const events = parseClaudeEvents(await readFile(fixture, 'utf8'));

    expect(events.map((event) => event.type)).toEqual([
      'system',
      'future_event',
      'assistant',
      'result',
    ]);
    expect(events[1]?.raw).toEqual({ type: 'future_event', value: 1 });
  });

  it.each([
    ['malformed JSON', '{not-json', 1],
    ['a non-object event', '[]', 1],
    ['a later malformed line', `${JSON.stringify(init())}\nfalse`, 2],
  ])('rejects %s with its line number', (_label, input, line) => {
    expect(() => parseClaudeEvents(input)).toThrow(ClaudeEventParseError);
    expect(() => parseClaudeEvents(input)).toThrow(new RegExp(`line ${String(line)}`));
  });
});

describe('Claude terminal contract', () => {
  it('normalizes successful text, model, usage, duration, and provider without inventing cost', async () => {
    const events = parseClaudeEvents(await readFile(fixture, 'utf8'));
    const result = evaluateClaudeResult(events, {
      exitCode: 0,
      requestedModel: 'claude-sonnet-5',
    });

    expect(result).toEqual({
      status: 'completed',
      provider: 'claude',
      requested_model: 'claude-sonnet-5',
      reported_model: 'claude-sonnet-5',
      text: 'Implemented slugify.',
      duration_ms: 1234,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      },
    });
    expect(result).not.toHaveProperty('cost');
  });

  it.each([
    ['missing result', jsonl(init())],
    ['empty result text', jsonl(init(), resultEvent({ result: '' }))],
    ['truncated result', jsonl(init(), { type: 'assistant' })],
  ])('fails %s as agent_failed', (_label, input) => {
    const result = evaluateClaudeResult(parseClaudeEvents(input), {
      exitCode: 0,
      requestedModel: 'claude-sonnet-5',
    });

    expect(result.status).toBe('failed');
    expect(result.failure_category).toBe('agent_failed');
  });

  it('fails a successful terminal event when the process exits non-zero', () => {
    const result = evaluateClaudeResult(parseClaudeEvents(jsonl(init(), resultEvent())), {
      exitCode: 7,
      requestedModel: 'claude-sonnet-5',
    });

    expect(result.status).toBe('failed');
    expect(result.failure_category).toBe('agent_failed');
  });

  it('classifies only the measured terminal API-error signal as provider_error', () => {
    const provider = evaluateClaudeResult(
      parseClaudeEvents(
        jsonl(
          init(),
          resultEvent({
            subtype: 'error_during_execution',
            is_error: true,
            terminal_reason: 'api_error',
            api_error_status: 429,
            result: 'wording is irrelevant',
          }),
        ),
      ),
      { exitCode: 1, requestedModel: 'claude-sonnet-5' },
    );
    const agent = evaluateClaudeResult(
      parseClaudeEvents(jsonl(init(), resultEvent({ is_error: true, result: 'bad output' }))),
      { exitCode: 1, requestedModel: 'claude-sonnet-5' },
    );

    expect(provider.failure_category).toBe('provider_error');
    expect(agent.failure_category).toBe('agent_failed');
    expect(FAILURE_CATEGORIES).toContain('provider_error');
  });

  // The gate measured that Claude has no silent-fallback signal: a wrong model returns a
  // terminal api_error, which the test above already classifies. So both names are recorded
  // and neither is judged — comparing provider-owned model strings would turn a harmless
  // alias or suffix change on their side into an outage on every Claude run.
  it.each([
    ['a differing reported model', jsonl(init('claude-sonnet-5-20260514'), resultEvent()), 'claude-sonnet-5-20260514'],
    ['no reported model at all', jsonl(resultEvent()), null],
  ] as const)('records both model names without judging them: %s', (_label, stream, reported) => {
    const result = evaluateClaudeResult(parseClaudeEvents(stream), {
      exitCode: 0,
      requestedModel: 'claude-sonnet-5',
    });

    expect(result).toMatchObject({
      status: 'completed',
      requested_model: 'claude-sonnet-5',
      reported_model: reported,
    });
    expect(result).not.toHaveProperty('failure_category');
  });
});
