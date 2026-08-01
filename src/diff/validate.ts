import picomatch from 'picomatch';

import { escapesTree } from '../util/paths.js';
import type { Change } from './source-diff.js';

export type DiffViolation =
  | 'no_changes'
  | 'out_of_scope'
  | 'dependency_change'
  | 'unsafe_symlink';

export class DiffValidationError extends Error {
  readonly violation: DiffViolation;
  readonly path: string | undefined;

  constructor(violation: DiffViolation, message: string, path?: string) {
    super(message);
    this.name = 'DiffValidationError';
    this.violation = violation;
    this.path = path;
  }
}

/** DESIGN.md §13: agents cannot persistently modify manifests or lockfiles. */
const DEPENDENCY_MANIFESTS = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
];

export interface ValidatedChangeSet {
  changes: Change[];
}

function inScope(path: string, patterns: readonly string[]): boolean {
  return patterns.some(
    // A declared directory covers everything under it; a glob is matched as written.
    (pattern) => picomatch(pattern, { dot: true })(path) || path.startsWith(`${pattern}/`),
  );
}

/**
 * Validate the source diff against the declared scope.
 *
 * A dependency-manifest change is its own violation rather than a generic out-of-scope one:
 * §13's request-and-approve flow starts from that signal, so the two must be distinguishable.
 */
export function validateChanges(
  changes: Change[],
  implementationPaths: readonly string[],
): ValidatedChangeSet {
  if (changes.length === 0) {
    throw new DiffValidationError('no_changes', 'the agent made no changes to the workspace');
  }

  for (const change of changes) {
    const name = change.path.split('/').at(-1) ?? '';

    if (DEPENDENCY_MANIFESTS.includes(name)) {
      throw new DiffValidationError(
        'dependency_change',
        `"${change.path}" is a dependency manifest: dependency changes go through approval, not the agent`,
        change.path,
      );
    }

    const target = change.entry?.linkTarget;
    if (target !== undefined && escapesTree(change.path, target)) {
      throw new DiffValidationError(
        'unsafe_symlink',
        `"${change.path}" is a symlink pointing outside the workspace (target "${target}")`,
        change.path,
      );
    }

    if (!inScope(change.path, implementationPaths)) {
      throw new DiffValidationError(
        'out_of_scope',
        `"${change.path}" is outside the declared implementation paths ` +
          `(${implementationPaths.join(', ')})`,
        change.path,
      );
    }
  }

  return { changes };
}
