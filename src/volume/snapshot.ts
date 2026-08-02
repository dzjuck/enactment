import { readFile } from 'node:fs/promises';

import { sha256, type ArtifactStore, type StoredArtifact } from '../artifacts/store.js';
import type { RuntimeImages } from '../docker/images.js';
import { runContainer } from '../docker/run.js';
import { WORKSPACE_PATH, workspaceMount } from './workspace.js';

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/**
 * `--sort=name` and `--numeric-owner` are what make two snapshots of an unchanged workspace
 * byte-identical. `node_modules` lives in its own volume (§12): including it would make
 * snapshots enormous and dependency writes indistinguishable from source writes.
 */
const SNAPSHOT_ARGV = [
  'tar',
  '--create',
  '--sort=name',
  '--numeric-owner',
  '--format=gnu',
  '--exclude=./node_modules',
  '--exclude=*/node_modules',
  '--file',
  '-',
  '--directory',
  WORKSPACE_PATH,
  '.',
];

/**
 * The archive is validated before anything is deleted, so a corrupt or truncated snapshot
 * leaves the workspace untouched rather than half-written.
 */
const RESTORE_SCRIPT = [
  'set -e',
  'cat > /tmp/restore.tar',
  'tar --list --file /tmp/restore.tar > /dev/null',
  `find ${WORKSPACE_PATH} -mindepth 1 -delete`,
  `tar --extract --preserve-permissions --file /tmp/restore.tar --directory ${WORKSPACE_PATH}`,
].join('\n');

export async function snapshotWorkspace(
  volume: string,
  store: ArtifactStore,
  images: RuntimeImages,
): Promise<StoredArtifact> {
  const result = await runContainer({
    image: images.setup.reference,
    argv: SNAPSHOT_ARGV,
    network: 'none',
    mounts: [workspaceMount(volume)],
  });

  if (result.exitCode !== 0) {
    throw new SnapshotError(`snapshot of ${volume} failed (${result.exitCode}): ${result.stderr}`);
  }

  return store.put(result.stdoutBytes);
}

export async function restoreWorkspace(
  volume: string,
  snapshot: StoredArtifact,
  images: RuntimeImages,
): Promise<void> {
  const bytes = await readFile(snapshot.path);

  if (sha256(bytes) !== snapshot.hash) {
    throw new SnapshotError(`snapshot ${snapshot.path} does not match its content hash`);
  }

  const result = await runContainer(
    {
      image: images.setup.reference,
      argv: ['sh', '-c', RESTORE_SCRIPT],
      network: 'none',
      mounts: [workspaceMount(volume)],
    },
    { input: bytes },
  );

  if (result.exitCode !== 0) {
    throw new SnapshotError(`restore into ${volume} failed (${result.exitCode}): ${result.stderr}`);
  }
}
