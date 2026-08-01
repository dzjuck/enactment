import { posix } from 'node:path';

/**
 * A symlink resolving outside the tree would let extraction — or acceptance — write outside
 * the workspace, so it is refused wherever one appears.
 */
export function escapesTree(linkPath: string, target: string): boolean {
  if (target.startsWith('/')) return true;

  const resolved = posix.normalize(posix.join(posix.dirname(linkPath), target));
  return resolved === '..' || resolved.startsWith('../');
}
