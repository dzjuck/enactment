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

/** One disposable volume containing only the before/after files selected for review. */
export function reviewVolumeName(attempt: string): string {
  return `${LABEL_PREFIX}-review-${attempt}`;
}

/** One dependency volume per phase (§12): the verifier never reuses the agent's. */
export function dependencyVolumeName(attempt: string, phase: string): string {
  return `${LABEL_PREFIX}-deps-${attempt}-${phase}`;
}

export type AuthProvider = 'codex' | 'claude';

/** Provider-scoped credential volume. A diagnosis can coexist with a Codex attempt. */
export function authVolumeName(provider: AuthProvider, attempt: string): string {
  return `${LABEL_PREFIX}-auth-${attempt}-${provider}`;
}

/**
 * The application under runtime verification. Its name is also its hostname: the behavioral
 * checkers reach it over Docker DNS on the attempt's internal runtime network.
 */
export function runtimeContainerName(attempt: string): string {
  return `${LABEL_PREFIX}-app-${attempt}`;
}

export function networkName(attempt: string, role: string): string {
  return `${LABEL_PREFIX}-net-${attempt}-${role}`;
}

/** Every attempt-scoped resource carries these, so cleanup can sweep by label. */
export function attemptLabels(attempt: string, role: string): Record<string, string> {
  return { [ATTEMPT_LABEL]: attempt, [ROLE_LABEL]: role };
}
