import type { ValidatedChangeSet } from '../diff/validate.js';
import { REVIEW_AFTER_ROOT, REVIEW_ARGS, REVIEW_BEFORE_ROOT } from './policy.js';

export interface ReviewTarget {
  readonly path: string;
  readonly content: Buffer;
}

export interface ReviewTargets {
  readonly before: readonly ReviewTarget[];
  readonly after: readonly ReviewTarget[];
}

/** Select only regular files from the already validated acceptance diff. */
export function deriveReviewTargets(changeSet: ValidatedChangeSet): ReviewTargets {
  const before: ReviewTarget[] = [];
  const after: ReviewTarget[] = [];

  for (const change of changeSet.changes) {
    if (change.kind === 'deleted') continue;
    if (change.entry?.type !== 'file') continue;
    const previous = change.previous;
    if (change.kind === 'modified' && previous?.type !== 'file') continue;

    after.push({ path: change.path, content: change.entry.content });
    if (change.kind === 'modified' && previous !== undefined) {
      before.push({ path: change.path, content: previous.content });
    }
  }

  const byPath = (left: ReviewTarget, right: ReviewTarget): number =>
    left.path.localeCompare(right.path);

  return { before: before.sort(byPath), after: after.sort(byPath) };
}

/** The reviewer caller can select targets, but cannot alter scanner policy. */
export function compileReviewArgv(): string[] {
  return [...REVIEW_ARGS, '--', REVIEW_BEFORE_ROOT, REVIEW_AFTER_ROOT];
}
