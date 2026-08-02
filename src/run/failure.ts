/**
 * A phase failure is classified, not just reported: DESIGN.md §5 requires a misconfigured
 * network to be distinguishable from a model that failed, and both from a model that worked
 * and produced a bad change.
 */
export const FAILURE_CATEGORIES = [
  'provider_connectivity_timeout',
  'agent_timeout',
  'agent_failed',
  'setup_timeout',
  'setup_failed',
  'verification_failed',
  'invalid_change',
  'internal_error',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export class PhaseFailure extends Error {
  readonly phase: string;
  readonly category: FailureCategory;

  constructor(phase: string, category: FailureCategory, message: string) {
    super(message);
    this.name = 'PhaseFailure';
    this.phase = phase;
    this.category = category;
  }
}
