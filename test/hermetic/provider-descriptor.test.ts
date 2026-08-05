import { describe, expect, it } from 'vitest';

import { compileClaudePolicy } from '../../src/adapters/claude/policy.js';
import { compileCodexPolicy } from '../../src/adapters/codex/policy.js';
import { providerDescriptor } from '../../src/adapters/provider.js';
import {
  CLAUDE_PROVIDER_ALLOWLIST,
  CLAUDE_VERSION,
  CODEX_PROVIDER_ALLOWLIST,
  CODEX_VERSION,
} from '../../src/config/pins.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { PROFILES } from '../../src/routing/profiles.js';

const IMAGES: RuntimeImages = {
  codex: { role: 'codex', id: `sha256:${'a'.repeat(64)}` },
  claude: { role: 'claude', id: `sha256:${'b'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'c'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'d'.repeat(64)}` },
  reviewer: { role: 'reviewer', id: `sha256:${'9'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'e'.repeat(64)}` },
};

describe('provider descriptor', () => {
  it('selects every Codex-owned runtime behavior', () => {
    const descriptor = providerDescriptor(PROFILES['codex-fast']);

    expect(descriptor.provider).toBe('codex');
    expect(descriptor.cliVersion).toBe(CODEX_VERSION);
    expect(descriptor.allowlist).toBe(CODEX_PROVIDER_ALLOWLIST);
    expect(descriptor.image(IMAGES)).toBe(IMAGES.codex);
    expect(descriptor.authProvider).toBe('codex');
    expect(descriptor.copyBackAuth).toBe(true);
    expect(descriptor.compile('Do the task.')).toEqual(
      compileCodexPolicy({
        prompt: 'Do the task.',
        workdir: '/workspace',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'medium',
      }),
    );
  });

  it('selects every Claude-owned runtime behavior', () => {
    const descriptor = providerDescriptor(PROFILES['claude-balanced']);

    expect(descriptor.provider).toBe('claude');
    expect(descriptor.cliVersion).toBe(CLAUDE_VERSION);
    expect(descriptor.allowlist).toBe(CLAUDE_PROVIDER_ALLOWLIST);
    expect(descriptor.image(IMAGES)).toBe(IMAGES.claude);
    expect(descriptor.authProvider).toBe('claude');
    expect(descriptor.copyBackAuth).toBe(false);
    // The compiled policy is exactly what the Claude runner rebuilds from the same profile
    // and prompt, which is why the runner does not need the compiled object handed to it.
    expect(descriptor.compile('Do the task.')).toEqual(
      compileClaudePolicy({
        mode: 'coding',
        prompt: 'Do the task.',
        model: 'claude-sonnet-5',
        effort: 'medium',
      }),
    );
  });
});
