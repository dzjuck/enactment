import { describe, expect, it } from 'vitest';

import { STEP_COMPLEXITIES } from '../../src/plan/schema.js';
import {
  NORMAL_ROUTES,
  PROFILES,
  PROFILE_IDS,
  STRONGER_PROFILE_ID,
  resolveNormalProfile,
  resolveProfile,
  resolveStrongerProfile,
} from '../../src/routing/profiles.js';

describe('fixed provider profiles', () => {
  it('uniquely resolves every profile ID to its exact provider, model and effort', () => {
    expect(PROFILE_IDS).toEqual([
      'codex-fast',
      'codex-deep',
      'claude-balanced',
      'claude-deep',
    ]);
    expect(new Set(PROFILE_IDS).size).toBe(PROFILE_IDS.length);
    expect(PROFILES).toEqual({
      'codex-fast': {
        id: 'codex-fast',
        provider: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'medium',
      },
      'codex-deep': {
        id: 'codex-deep',
        provider: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'high',
      },
      'claude-balanced': {
        id: 'claude-balanced',
        provider: 'claude',
        model: 'claude-sonnet-5',
        effort: 'medium',
      },
      'claude-deep': {
        id: 'claude-deep',
        provider: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
      },
    });

    for (const id of PROFILE_IDS) expect(resolveProfile(id)).toEqual(PROFILES[id]);
    expect(Object.values(PROFILES).map((profile) => profile.model).join(' ')).not.toMatch(/latest/i);
  });

  it('uses the exact deterministic normal routes and stronger profile', () => {
    expect(NORMAL_ROUTES).toEqual({
      low: 'codex-fast',
      medium: 'claude-balanced',
      high: 'codex-deep',
    });
    expect(STRONGER_PROFILE_ID).toBe('claude-deep');

    expect(resolveNormalProfile('low')).toBe(PROFILES['codex-fast']);
    expect(resolveNormalProfile('medium')).toBe(PROFILES['claude-balanced']);
    expect(resolveNormalProfile('high')).toBe(PROFILES['codex-deep']);
    expect(resolveStrongerProfile()).toBe(PROFILES['claude-deep']);
  });

  it('keeps every normal route different from the stronger profile', () => {
    for (const complexity of STEP_COMPLEXITIES) {
      expect(NORMAL_ROUTES[complexity]).not.toBe(STRONGER_PROFILE_ID);
      expect(resolveNormalProfile(complexity).id).not.toBe(resolveStrongerProfile().id);
    }
  });
});
