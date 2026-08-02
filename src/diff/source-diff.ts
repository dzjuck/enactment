import { createHash } from 'node:crypto';

import { readArchive } from '../artifacts/archive.js';

export interface FileEntry {
  path: string;
  type: 'file' | 'symlink';
  mode: number;
  hash: string;
  content: Buffer;
  linkTarget?: string;
}

export type FileManifest = Map<string, FileEntry>;

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface Change {
  kind: ChangeKind;
  path: string;
  /** The accepted content, for additions and modifications. */
  entry?: FileEntry;
  previous?: FileEntry;
}

/**
 * DESIGN.md §12: dependency-volume writes are excluded from source diffs, and the synthetic
 * repository is workspace scaffolding rather than a change the agent made.
 */
const EXCLUDED = [/^node_modules(\/|$)/, /^\.git(\/|$)/];

function excluded(path: string): boolean {
  return EXCLUDED.some((pattern) => pattern.test(path));
}

/** Normalizes `./x` (snapshot tars) and `x` (git archive) to one form. */
function normalize(path: string): string {
  return path.replace(/^\.\//, '');
}

export async function manifestFromTar(tar: Buffer): Promise<FileManifest> {
  const manifest: FileManifest = new Map();

  for (const entry of await readArchive(tar)) {
    if (entry.type === 'directory') continue;

    const path = normalize(entry.path);
    if (path === '') continue;

    manifest.set(path, {
      path,
      type: entry.type,
      mode: entry.mode,
      hash: createHash('sha256').update(entry.content).digest('hex'),
      content: entry.content,
      ...(entry.type === 'symlink' ? { linkTarget: entry.linkPath } : {}),
    });
  }

  return manifest;
}

function differs(before: FileEntry, after: FileEntry): boolean {
  return (
    before.hash !== after.hash ||
    before.mode !== after.mode ||
    before.type !== after.type ||
    before.linkTarget !== after.linkTarget
  );
}

export function diffManifests(before: FileManifest, after: FileManifest): Change[] {
  const changes: Change[] = [];

  for (const [path, entry] of after) {
    if (excluded(path)) continue;

    const previous = before.get(path);
    if (previous === undefined) changes.push({ kind: 'added', path, entry });
    else if (differs(previous, entry)) changes.push({ kind: 'modified', path, entry, previous });
  }

  for (const [path, previous] of before) {
    if (excluded(path)) continue;
    if (!after.has(path)) changes.push({ kind: 'deleted', path, previous });
  }

  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

/** Compare the canonical export against the immutable implementation snapshot. */
export async function sourceDiff(exportTar: Buffer, snapshotTar: Buffer): Promise<Change[]> {
  return diffManifests(await manifestFromTar(exportTar), await manifestFromTar(snapshotTar));
}
