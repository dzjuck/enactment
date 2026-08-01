import { describe, expect, it } from 'vitest';

import {
  CODEX_VERSION,
  PROVIDER_ALLOWLIST,
  PROVIDER_ALLOWLIST_CODEX_VERSION,
} from '../../src/config/pins.js';
import { networkPolicySection } from '../../src/run/manifest.js';

describe('provider allowlist', () => {
  it('is exactly chatgpt.com', () => {
    expect([...PROVIDER_ALLOWLIST]).toEqual(['chatgpt.com']);
  });

  it('is hashed into the run manifest', () => {
    const section = networkPolicySection();

    expect(section.allowed_hosts).toEqual(['chatgpt.com']);
    expect(section.network_policy_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(networkPolicySection(['chatgpt.com', 'ab.chatgpt.com']).network_policy_hash).not.toBe(
      section.network_policy_hash,
    );
  });

  it('records the Codex version the list was discovered against', () => {
    expect(networkPolicySection().codex_version).toBe(CODEX_VERSION);

    // §7 makes the list version-specific: bumping Codex without re-running domain discovery
    // must be detectable, so the discovery marker is its own literal.
    expect(PROVIDER_ALLOWLIST_CODEX_VERSION).toBe(CODEX_VERSION);
  });
});
