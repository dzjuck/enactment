import { describe, expect, it } from 'vitest';

import {
  CLAUDE_PROVIDER_ALLOWLIST,
  CLAUDE_VERSION,
  CODEX_PROVIDER_ALLOWLIST,
  CODEX_VERSION,
  PROVIDER_ALLOWLIST_CLAUDE_VERSION,
  PROVIDER_ALLOWLIST_CODEX_VERSION,
} from '../../src/config/pins.js';
import { networkPolicySection } from '../../src/run/manifest.js';

describe('provider allowlist', () => {
  it('keeps exact, provider-specific allowlists', () => {
    expect([...CODEX_PROVIDER_ALLOWLIST]).toEqual(['chatgpt.com', 'auth.openai.com']);
    expect([...CLAUDE_PROVIDER_ALLOWLIST]).toEqual(['api.anthropic.com']);
  });

  it('is hashed into the run manifest', () => {
    const section = networkPolicySection(CODEX_PROVIDER_ALLOWLIST, CODEX_VERSION);

    expect(section.allowed_hosts).toEqual(['chatgpt.com', 'auth.openai.com']);
    expect(section.network_policy_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      networkPolicySection(['chatgpt.com', 'ab.chatgpt.com'], CODEX_VERSION).network_policy_hash,
    ).not.toBe(section.network_policy_hash);
  });

  // The section describes whichever provider the attempt ran, so its version field is named
  // for none of them. A Claude attempt recording `codex_version: 2.1.221` is wrong evidence.
  it('records the provider CLI version the list was discovered against', () => {
    expect(networkPolicySection(CODEX_PROVIDER_ALLOWLIST, CODEX_VERSION)).toMatchObject({
      allowed_hosts: ['chatgpt.com', 'auth.openai.com'],
      cli_version: CODEX_VERSION,
    });

    const claude = networkPolicySection(CLAUDE_PROVIDER_ALLOWLIST, CLAUDE_VERSION);
    expect(claude).toMatchObject({
      allowed_hosts: ['api.anthropic.com'],
      cli_version: CLAUDE_VERSION,
    });
    expect(claude).not.toHaveProperty('codex_version');

    // §7 makes the list version-specific: bumping either CLI without re-running domain
    // discovery must be detectable, so each discovery marker is its own literal.
    expect(PROVIDER_ALLOWLIST_CODEX_VERSION).toBe(CODEX_VERSION);
    expect(PROVIDER_ALLOWLIST_CLAUDE_VERSION).toBe(CLAUDE_VERSION);
  });
});
