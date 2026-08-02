import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../src/artifacts/store.js';
import { IMAGE_PINS } from '../../src/config/pins.js';
import { sourceDiff } from '../../src/diff/source-diff.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { runContainer } from '../../src/docker/run.js';
import { exportCommit } from '../../src/git/export.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { snapshotWorkspace } from '../../src/volume/snapshot.js';
import { createWorkspaceVolume, removeVolume, workspaceMount } from '../../src/volume/workspace.js';
import { runtimeImages } from '../helpers/images.js';
import { createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';

let repo: TargetRepo;
let tar: Buffer;
let store: ArtifactStore;
let root: string;
let images: RuntimeImages;

beforeAll(async () => {
  images = await runtimeImages();
  repo = await createTargetRepo();
  ({ tar } = await exportCommit(repo.dir, repo.commit));
  root = await mkdtemp(join(tmpdir(), 'harness-implsnap-'));
  store = new ArtifactStore(root);
});

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

describe('implementation snapshot', () => {
  it('is immutable: later workspace mutations do not change what was captured', async () => {
    const volume = await createWorkspaceVolume(newAttemptId(), tar, images);

    try {
      await runContainer({
        image: IMAGE_PINS.agent.tag,
        argv: ['sh', '-c', 'echo "export const slugify = () => \'done\';" > /workspace/src/slugify.js'],
        network: 'none',
        mounts: [workspaceMount(volume)],
      });

      // §15: the pre-verification snapshot is the only acceptance candidate.
      const snapshot = await snapshotWorkspace(volume, store, images);
      const captured = await store.read(snapshot.hash);

      await runContainer({
        image: IMAGE_PINS.agent.tag,
        argv: [
          'sh',
          '-c',
          'echo tampered > /workspace/src/slugify.js && touch /workspace/AFTER_VERIFICATION',
        ],
        network: 'none',
        mounts: [workspaceMount(volume)],
      });

      const stillCaptured = await store.read(snapshot.hash);
      expect(stillCaptured.equals(captured)).toBe(true);

      const changes = sourceDiff(tar, captured);
      const paths = changes.map((change) => change.path);

      expect(paths).toContain('src/slugify.js');
      expect(paths).not.toContain('AFTER_VERIFICATION');

      const accepted = changes.find((change) => change.path === 'src/slugify.js');
      expect(accepted?.entry?.content.toString()).toContain('done');
      expect(accepted?.entry?.content.toString()).not.toContain('tampered');
    } finally {
      await removeVolume(volume);
    }
  }, 180_000);
});
