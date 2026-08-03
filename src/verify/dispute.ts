import type { Change } from '../diff/source-diff.js';

export const DISPUTE_PATH = '.harness/test-contract-dispute.md';

export interface TestContractDispute {
  path: typeof DISPUTE_PATH;
  reason: string;
}

export function captureTestContractDispute(
  changes: readonly Change[],
): TestContractDispute | undefined {
  const change = changes.find(
    (candidate) => candidate.path === DISPUTE_PATH && candidate.entry?.type === 'file',
  );
  if (change?.entry === undefined) return undefined;

  return {
    path: DISPUTE_PATH,
    reason: change.entry.content.toString('utf8').trim(),
  };
}

export function implementationScopeWithDispute(
  implementationPaths: readonly string[],
): string[] {
  return [...implementationPaths, DISPUTE_PATH];
}

export function excludeDispute(changes: readonly Change[]): Change[] {
  return changes.filter((change) => change.path !== DISPUTE_PATH);
}
