import { describe, expect, it } from 'vitest';

import { PROFILES } from '../../src/routing/profiles.js';
import { RETRYABLE_FAILURE_CATEGORIES } from '../../src/run/failure.js';
import { nextAttempt } from '../../src/run/selection.js';
import type { AttemptRecord, StepRecord } from '../../src/state/store.js';

const PARENT = 'a'.repeat(40);
const STEP: StepRecord = {
  row: 1,
  planRow: 1,
  position: 0,
  stepId: 'demo',
  status: 'pending',
};

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    row: 1,
    stepRow: STEP.row,
    attemptId: 'attempt-1',
    ordinal: 1,
    state: 'failed',
    phase: 'implementation',
    profileId: 'codex-fast',
    kind: 'normal',
    parentCommit: PARENT,
    artifactPath: '/artifacts/run-1',
    runs: 1,
    failure: 'agent_failed: injected',
    ...overrides,
  };
}

function select(attempts: AttemptRecord[] = [], complexity: 'low' | 'medium' | 'high' = 'low') {
  return nextAttempt({ step: STEP, complexity, attempts, parentCommit: PARENT });
}

describe('persisted attempt selection', () => {
  it('defines the retryable category allowlist once', () => {
    expect([...RETRYABLE_FAILURE_CATEGORIES]).toEqual([
      'agent_failed',
      'invalid_change',
      'closure_violation',
      'red_invalid',
      'verification_failed',
    ]);
  });

  it.each([
    ['low', 'codex-fast'],
    ['medium', 'claude-balanced'],
    ['high', 'codex-deep'],
  ] as const)('starts a normal %s-complexity attempt on %s', (complexity, profileId) => {
    expect(select([], complexity)).toEqual({
      action: 'start',
      kind: 'normal',
      profile: PROFILES[profileId],
      parentCommit: PARENT,
    });
  });

  it.each([
    ['normal', 'codex-fast', undefined],
    ['stronger', 'claude-deep', 8],
  ] as const)('reuses a running %s attempt with its persisted profile', (kind, profileId, retryOf) => {
    const running = attempt({
      row: 9,
      attemptId: 'crashed',
      state: 'running',
      kind,
      profileId,
      retryOfAttemptRow: retryOf,
      parentCommit: 'b'.repeat(40),
    });

    expect(select([running], 'medium')).toEqual({
      action: 'reuse',
      kind,
      profile: PROFILES[profileId],
      parentCommit: 'b'.repeat(40),
      attempt: running,
      retryOfAttemptRow: retryOf,
    });
  });

  it.each([
    'agent_failed',
    'invalid_change',
    'closure_violation',
    'red_invalid',
    'verification_failed',
  ] as const)('selects one stronger child after %s', (category) => {
    const failed = attempt({ row: 6, failure: `${category}: injected` });

    expect(select([failed])).toEqual({
      action: 'start',
      kind: 'stronger',
      profile: PROFILES['claude-deep'],
      parentCommit: PARENT,
      retryOfAttemptRow: 6,
    });
  });

  it.each([
    'provider_error',
    'agent_timeout',
    'test_contract_disputed',
    'baseline_failed',
    'setup_timeout',
    'setup_failed',
    'provider_connectivity_timeout',
    'internal_error',
  ] as const)('does not select a stronger child after %s', (category) => {
    expect(select([attempt({ failure: `${category}: injected` })])?.kind).toBe('normal');
  });

  it('starts a new normal cycle when a failed normal already has a child', () => {
    const normal = attempt({ row: 4 });
    const child = attempt({
      row: 5,
      ordinal: 2,
      attemptId: 'attempt-2',
      profileId: 'claude-deep',
      kind: 'stronger',
      retryOfAttemptRow: 4,
      failure: 'agent_failed: stronger failed',
    });

    expect(select([normal, child])?.kind).toBe('normal');
  });

  it('never gives a failed stronger attempt another stronger child', () => {
    expect(
      select([
        attempt({
          profileId: 'claude-deep',
          kind: 'stronger',
          retryOfAttemptRow: 3,
        }),
      ])?.kind,
    ).toBe('normal');
  });

  it('selects nothing for a completed step', () => {
    expect(nextAttempt({ ...selectInput(), step: { ...STEP, status: 'completed' } })).toBeUndefined();
  });
});

function selectInput() {
  return { step: STEP, complexity: 'low' as const, attempts: [], parentCommit: PARENT };
}
