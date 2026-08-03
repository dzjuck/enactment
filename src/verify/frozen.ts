import { createHash } from 'node:crypto';

import picomatch from 'picomatch';

import type { Change, FileManifest } from '../diff/source-diff.js';

export type FrozenPhase = 'tests' | 'implementation';

export function frozenPathsForPhase(
  phase: FrozenPhase,
  closurePaths: readonly string[],
  testPaths: readonly string[],
): string[] {
  return phase === 'tests' ? [...closurePaths] : [...closurePaths, ...testPaths];
}

function matchesFrozenPath(path: string, patterns: readonly string[]): boolean {
  return patterns.some(
    (pattern) => picomatch(pattern, { dot: true })(path) || path.startsWith(`${pattern}/`),
  );
}

export function frozenChange(
  changes: readonly Change[],
  patterns: readonly string[],
): Change | undefined {
  return changes.find((change) => matchesFrozenPath(change.path, patterns));
}

export function frozenSetEvidence(
  manifest: FileManifest,
  patterns: readonly string[],
): { digest: string; paths: string[] } {
  const entries = [...manifest.values()]
    .filter((entry) => matchesFrozenPath(entry.path, patterns))
    .map((entry) => [entry.path, entry.hash] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  return {
    digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    paths: entries.map(([path]) => path),
  };
}
