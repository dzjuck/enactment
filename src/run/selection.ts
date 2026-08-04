import type { StepComplexity } from '../plan/schema.js';
import {
  resolveNormalProfile,
  resolveProfile,
  resolveStrongerProfile,
  type AgentProfile,
} from '../routing/profiles.js';
import type { AttemptKind, AttemptRecord, StepRecord } from '../state/store.js';
import {
  RETRYABLE_FAILURE_CATEGORIES,
  type FailureCategory,
} from './failure.js';

export interface NextAttemptInput {
  step: StepRecord;
  complexity: StepComplexity;
  attempts: AttemptRecord[];
  parentCommit: string;
}

export type AttemptSelection =
  | {
      action: 'start';
      kind: 'normal';
      profile: AgentProfile;
      parentCommit: string;
    }
  | {
      action: 'start';
      kind: 'stronger';
      profile: AgentProfile;
      parentCommit: string;
      retryOfAttemptRow: number;
    }
  | {
      action: 'reuse';
      kind: AttemptKind;
      profile: AgentProfile;
      parentCommit: string;
      attempt: AttemptRecord;
      retryOfAttemptRow: number | undefined;
    };

function failureCategory(attempt: AttemptRecord): FailureCategory | undefined {
  const category = attempt.failure?.split(':', 1)[0];
  return category === undefined ? undefined : (category as FailureCategory);
}

/** Decide one step's next attempt from persisted state only. */
export function nextAttempt(input: NextAttemptInput): AttemptSelection | undefined {
  if (input.step.status === 'completed') return undefined;

  const running = input.attempts.find((attempt) => attempt.state === 'running');
  if (running !== undefined) {
    return {
      action: 'reuse',
      kind: running.kind,
      profile: resolveProfile(running.profileId),
      parentCommit: running.parentCommit,
      attempt: running,
      retryOfAttemptRow: running.retryOfAttemptRow,
    };
  }

  const latest = input.attempts.at(-1);
  const retryable =
    latest?.kind === 'normal' &&
    latest.state === 'failed' &&
    RETRYABLE_FAILURE_CATEGORIES.has(failureCategory(latest) as FailureCategory);
  const hasChild =
    latest !== undefined &&
    input.attempts.some((attempt) => attempt.retryOfAttemptRow === latest.row);

  if (retryable && !hasChild && latest !== undefined) {
    return {
      action: 'start',
      kind: 'stronger',
      profile: resolveStrongerProfile(),
      parentCommit: latest.parentCommit,
      retryOfAttemptRow: latest.row,
    };
  }

  return {
    action: 'start',
    kind: 'normal',
    profile: resolveNormalProfile(input.complexity),
    parentCommit: input.parentCommit,
  };
}
