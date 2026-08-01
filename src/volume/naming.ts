import { randomUUID } from 'node:crypto';

export const LABEL_PREFIX = 'ai-harness';
export const ATTEMPT_LABEL = `${LABEL_PREFIX}.attempt`;
export const ROLE_LABEL = `${LABEL_PREFIX}.role`;

export function newAttemptId(): string {
  return randomUUID().replaceAll('-', '').slice(0, 16);
}

export function workspaceVolumeName(attempt: string): string {
  return `${LABEL_PREFIX}-ws-${attempt}`;
}

/** One dependency volume per phase (§12): the verifier never reuses the agent's. */
export function dependencyVolumeName(attempt: string, phase: string): string {
  return `${LABEL_PREFIX}-deps-${attempt}-${phase}`;
}

/** Every attempt-scoped resource carries these, so cleanup can sweep by label. */
export function attemptLabels(attempt: string, role: string): Record<string, string> {
  return { [ATTEMPT_LABEL]: attempt, [ROLE_LABEL]: role };
}
