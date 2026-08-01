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

/** Every attempt-scoped resource carries these, so cleanup can sweep by label. */
export function attemptLabels(attempt: string, role: string): Record<string, string> {
  return { [ATTEMPT_LABEL]: attempt, [ROLE_LABEL]: role };
}
