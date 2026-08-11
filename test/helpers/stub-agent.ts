import { execa } from 'execa';

import { AGENT_GID, AGENT_UID, NODE_BASE_IMAGE } from '../../src/config/pins.js';
import { resolveImageId, type RuntimeImage } from '../../src/docker/images.js';

export const STUB_AGENT_IMAGE = 'enactment/stub-agent:test';

/**
 * The stub's real runtime identity. Injection substitutes an image; it never suspends the
 * rule that what ran is what the manifest records.
 */
export async function stubAgentImage(): Promise<RuntimeImage> {
  return { role: 'codex', id: await resolveImageId(STUB_AGENT_IMAGE) };
}

export async function stubClaudeImage(): Promise<RuntimeImage> {
  return { role: 'claude', id: await resolveImageId(STUB_AGENT_IMAGE) };
}

export async function buildStubAgent(): Promise<string> {
  await execa('docker', [
    'build',
    '--build-arg',
    `BASE_IMAGE=${NODE_BASE_IMAGE}`,
    '--build-arg',
    `AGENT_UID=${String(AGENT_UID)}`,
    '--build-arg',
    `AGENT_GID=${String(AGENT_GID)}`,
    '--tag',
    STUB_AGENT_IMAGE,
    'images/stub-agent',
  ]);

  return STUB_AGENT_IMAGE;
}

/** Canned Codex-shaped JSONL. The real event shape is exercised by the live suite. */
export function cannedEvents(extra: Record<string, unknown>[] = []): string {
  return [
    { type: 'thread.started', thread_id: 'thread_stub' },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'Implemented slugify.' },
    },
    ...extra,
    {
      type: 'turn.completed',
      model: 'gpt-5.6-luna',
      usage: { input_tokens: 1234, output_tokens: 567, cached_input_tokens: 89 },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
}

export function cannedClaudeEvents(canary = ''): string {
  return [
    { type: 'system', subtype: 'init', model: 'claude-sonnet-5' },
    { type: 'future_event', detail: canary },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `Implemented slugify. ${canary}`,
      duration_ms: 25,
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
}
