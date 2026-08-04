import type { StepComplexity } from '../plan/schema.js';

export const PROFILE_IDS = [
  'codex-fast',
  'codex-deep',
  'claude-balanced',
  'claude-deep',
] as const;

export type ProfileId = (typeof PROFILE_IDS)[number];

export interface AgentProfile {
  id: ProfileId;
  provider: 'codex' | 'claude';
  model: string;
  effort: string;
}

export const PROFILES: Record<ProfileId, AgentProfile> = {
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
};

export const NORMAL_ROUTES: Record<StepComplexity, ProfileId> = {
  low: 'codex-fast',
  medium: 'claude-balanced',
  high: 'codex-deep',
};

export const STRONGER_PROFILE_ID: ProfileId = 'claude-deep';

export function resolveProfile(id: ProfileId): AgentProfile {
  return PROFILES[id];
}

export function resolveNormalProfile(complexity: StepComplexity): AgentProfile {
  return resolveProfile(NORMAL_ROUTES[complexity]);
}

export function resolveStrongerProfile(): AgentProfile {
  return resolveProfile(STRONGER_PROFILE_ID);
}
