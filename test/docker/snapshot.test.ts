import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../src/artifacts/store.js';
import { IMAGE_PINS } from '../../src/config/pins.js';
import { exportCommit } from '../../src/git/export.js';
import { runContainer, type RunResult } from '../../src/docker/run.js';
import { SnapshotError, restoreWorkspace, snapshotWorkspace } from '../../src/volume/snapshot.js';
import { attemptLabels, newAttemptId, workspaceVolumeName } from '../../src/volume/naming.js';
import {
  createVolume,
  createWorkspaceVolume,
  removeVolume,
  workspaceMount,
} from '../../src/volume/workspace.js';
import { createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { readTar } from '../../src/artifacts/tar.js';

let repo: TargetRepo;
let tar: Buffer;
let store: ArtifactStore;
let storeRoot: string;
const created: string[] = [];

beforeAll(async () => {
  repo = await createTargetRepo();
  ({ tar } = await exportCommit(repo.dir, repo.commit));
  storeRoot = await mkdtemp(join(tmpdir(), 'harness-artifacts-'));
  store = new ArtifactStore(storeRoot);
});

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(storeRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((name) => removeVolume(name)));
});

async function seed(): Promise<string> {
  const name = await createWorkspaceVolume(newAttemptId(), tar);
  created.push(name);
  return name;
}

async function emptyVolume(): Promise<string> {
  const attempt = newAttemptId();
  const name = workspaceVolumeName(attempt);
  await createVolume(name, attemptLabels(attempt, 'workspace'));
  created.push(name);
  return name;
}

function inWorkspace(name: string, argv: string[]): Promise<RunResult> {
  return runContainer({
    image: IMAGE_PINS.agent.tag,
    argv,
    network: 'none',
    mounts: [workspaceMount(name)],
  });
}

const listing = (name: string): Promise<RunResult> =>
  inWorkspace(name, ['sh', '-c', 'find /workspace -mindepth 1 | sort']);

describe('workspace snapshots', () => {
  it('restores a mutated workspace exactly, including undoing additions', async () => {
    const volume = await seed();
    const before = await listing(volume);

    const snapshot = await snapshotWorkspace(volume, store);

    await inWorkspace(volume, [
      'sh',
      '-c',
      'echo mutated > /workspace/README.md && rm /workspace/AGENTS.md && touch /workspace/EXTRA',
    ]);

    await restoreWorkspace(volume, snapshot);

    const after = await listing(volume);
    const readme = await inWorkspace(volume, ['cat', '/workspace/README.md']);

    expect(after.stdout).toBe(before.stdout);
    expect(after.stdout).not.toContain('/workspace/EXTRA');
    expect(readme.stdout).toContain('target-repo');
  });

  it('stores the snapshot as a read-only, content-addressed artifact', async () => {
    const volume = await seed();
    const snapshot = await snapshotWorkspace(volume, store);

    expect(snapshot.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshot.path).toContain(snapshot.hash.slice('sha256:'.length));

    const mode = (await stat(snapshot.path)).mode & 0o777;
    expect(mode & 0o222).toBe(0);
  });

  it('hashes an unchanged workspace identically', async () => {
    const volume = await seed();

    const first = await snapshotWorkspace(volume, store);
    const second = await snapshotWorkspace(volume, store);

    expect(second.hash).toBe(first.hash);
  });

  it('restores into a fresh, empty volume', async () => {
    const source = await seed();
    const snapshot = await snapshotWorkspace(source, store);

    const target = await emptyVolume();
    await restoreWorkspace(target, snapshot);

    expect((await listing(target)).stdout).toBe((await listing(source)).stdout);
  });

  it('excludes node_modules, which lives in its own volume', async () => {
    const volume = await seed();
    await inWorkspace(volume, [
      'sh',
      '-c',
      'mkdir -p /workspace/node_modules/pkg && touch /workspace/node_modules/pkg/index.js',
    ]);

    const snapshot = await snapshotWorkspace(volume, store);
    const entries = readTar(await store.read(snapshot.hash)).map((entry) => entry.path);

    expect(entries.filter((path) => path.includes('node_modules'))).toEqual([]);
    expect(entries.some((path) => path.endsWith('package.json'))).toBe(true);
  });

  it('preserves symlinks and modes across the round trip', async () => {
    const source = await seed();
    const snapshot = await snapshotWorkspace(source, store);

    const target = await emptyVolume();
    await restoreWorkspace(target, snapshot);

    const link = await inWorkspace(target, ['readlink', '/workspace/docs/readme.md']);
    const executable = await inWorkspace(target, [
      'sh',
      '-c',
      'test -x /workspace/.githooks/pre-commit',
    ]);

    expect(link.stdout.trim()).toBe('../README.md');
    expect(executable.exitCode).toBe(0);
  });

  it('leaves the volume untouched when a restore fails', async () => {
    const volume = await seed();
    const before = await listing(volume);

    const corrupt = await store.put(Buffer.from('this is not a tar archive'), '.tar');

    await expect(restoreWorkspace(volume, corrupt)).rejects.toThrow(SnapshotError);
    expect((await listing(volume)).stdout).toBe(before.stdout);
  });
});
