import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { execa } from 'execa';

import { ArtifactStore } from '../../src/artifacts/store.js';
import { IMAGE_PINS } from '../../src/config/pins.js';
import { DependencyCache, ensureDependencySnapshot } from '../../src/deps/setup.js';
import {
  DependencyVolumeError,
  cloneDependencyVolume,
  createDependencyTemplate,
  createDependencyVolume,
  dependencyMount,
} from '../../src/deps/volume.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { runContainer, type RunResult } from '../../src/docker/run.js';
import { exportCommit } from '../../src/git/export.js';
import {
  dependencyTemplateVolumeName,
  dependencyVolumeName,
  newAttemptId,
} from '../../src/volume/naming.js';
import { snapshotWorkspace } from '../../src/volume/snapshot.js';
import {
  createWorkspaceVolume,
  removeVolume,
  volumeExists,
  workspaceMount,
} from '../../src/volume/workspace.js';
import { runtimeImages } from '../helpers/images.js';
import { createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { readArchive } from '../../src/artifacts/archive.js';

const KEY = 'sha256:dependency-volume-tests';

let repo: TargetRepo;
let tar: Buffer;
let deps: Buffer;
let root: string;
let images: RuntimeImages;
const created: string[] = [];

beforeAll(async () => {
  images = await runtimeImages();
  repo = await createTargetRepo();
  ({ tar } = await exportCommit(repo.dir, repo.commit));

  root = await mkdtemp(join(tmpdir(), 'enactment-depvol-'));
  const cache = new DependencyCache(root);
  await ensureDependencySnapshot({
    cache,
    key: KEY,
    attempt: newAttemptId(),
    workspaceTar: tar,
    installCommand: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    network: 'bridge',
    images,
  });
  deps = await cache.read(KEY);
}, 600_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((name) => removeVolume(name)));
});

async function seedWorkspace(): Promise<string> {
  const name = await createWorkspaceVolume(newAttemptId(), tar, images);
  created.push(name);
  return name;
}

async function seedDeps(attempt: string, phase: string): Promise<string> {
  const name = await createDependencyVolume(attempt, phase, deps, images);
  created.push(name);
  return name;
}

function inWorkspace(workspace: string, depsVolume: string, argv: string[]): Promise<RunResult> {
  return runContainer({
    image: IMAGE_PINS.verifier.tag,
    argv,
    network: 'none',
    mounts: [workspaceMount(workspace), dependencyMount(depsVolume)],
  });
}

describe('per-phase dependency volume', () => {
  it('makes the fixture test runner resolvable', async () => {
    const workspace = await seedWorkspace();
    const depsVolume = await seedDeps(newAttemptId(), 'agent');

    const result = await inWorkspace(workspace, depsVolume, [
      'npx',
      '--no-install',
      'vitest',
      '--version',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('vitest');
  });

  it('is writable, as the packages that need it require', async () => {
    const workspace = await seedWorkspace();
    const depsVolume = await seedDeps(newAttemptId(), 'agent');

    const result = await inWorkspace(workspace, depsVolume, [
      'sh',
      '-c',
      'touch /workspace/node_modules/.written-by-agent',
    ]);

    expect(result.exitCode).toBe(0);
  });

  it('never lets one phase see another phase dependency writes', async () => {
    const attempt = newAttemptId();
    const workspace = await seedWorkspace();

    const agentDeps = await seedDeps(attempt, 'agent');
    await inWorkspace(workspace, agentDeps, [
      'sh',
      '-c',
      'touch /workspace/node_modules/.agent-only',
    ]);

    const verifierDeps = await seedDeps(attempt, 'verifier');
    const leak = await inWorkspace(workspace, verifierDeps, [
      'sh',
      '-c',
      'test -e /workspace/node_modules/.agent-only',
    ]);

    expect(agentDeps).not.toBe(verifierDeps);
    expect(leak.exitCode).not.toBe(0);
  });

  it('is attempt-scoped and removable', async () => {
    const attempt = newAttemptId();
    const name = await seedDeps(attempt, 'agent');

    expect(name).toBe(dependencyVolumeName(attempt, 'agent'));
    expect(name).toContain(attempt);

    await removeVolume(name);
    await expect(volumeExists(name)).resolves.toBe(false);
  });

  /**
   * The tar reaches the daemon once per attempt instead of once per phase. What must not
   * change is the §12 guarantee: every phase still gets its own pristine tree.
   */
  describe('seeded once and cloned per phase', () => {
    async function template(attempt: string): Promise<string> {
      const name = await createDependencyTemplate(attempt, deps, images);
      created.push(name);
      return name;
    }

    async function clone(source: string, attempt: string, phase: string): Promise<string> {
      const name = await cloneDependencyVolume(source, attempt, phase, images);
      created.push(name);
      return name;
    }

    it('produces a clone with the same resolvable dependency tree as an extraction', async () => {
      const attempt = newAttemptId();
      const workspace = await seedWorkspace();
      const cloned = await clone(await template(attempt), attempt, 'verifier');

      const version = await inWorkspace(workspace, cloned, [
        'npx',
        '--no-install',
        'vitest',
        '--version',
      ]);

      expect(version.exitCode).toBe(0);
      expect(version.stdout).toContain('vitest');
    });

    it('gives each clone its own writable tree, isolated from its siblings', async () => {
      const attempt = newAttemptId();
      const workspace = await seedWorkspace();
      const source = await template(attempt);

      const first = await clone(source, attempt, 'agent');
      const written = await inWorkspace(workspace, first, [
        'sh',
        '-c',
        'touch /workspace/node_modules/.agent-only',
      ]);
      expect(written.exitCode).toBe(0);

      const second = await clone(source, attempt, 'verifier');
      const leak = await inWorkspace(workspace, second, [
        'sh',
        '-c',
        'test -e /workspace/node_modules/.agent-only',
      ]);

      expect(first).not.toBe(second);
      expect(leak.exitCode).not.toBe(0);
    });

    it('leaves the template itself untouched by what a clone writes', async () => {
      const attempt = newAttemptId();
      const workspace = await seedWorkspace();
      const source = await template(attempt);

      await inWorkspace(workspace, await clone(source, attempt, 'agent'), [
        'sh',
        '-c',
        'touch /workspace/node_modules/.agent-only',
      ]);

      const fresh = await clone(source, attempt, 'green');
      const leak = await inWorkspace(workspace, fresh, [
        'sh',
        '-c',
        'test -e /workspace/node_modules/.agent-only',
      ]);

      expect(leak.exitCode).not.toBe(0);
    });

    it('names and labels the template per attempt, so the attempt sweep reaches it', async () => {
      const attempt = newAttemptId();
      const name = await template(attempt);

      expect(name).toBe(dependencyTemplateVolumeName(attempt));
      expect(name).toContain(attempt);

      const { stdout } = await execa('docker', [
        'volume',
        'inspect',
        '--format',
        '{{index .Labels "enactment.attempt"}}',
        name,
      ]);
      expect(stdout.trim()).toBe(attempt);
    });

    it('refuses to clone from a template that does not exist', async () => {
      await expect(
        cloneDependencyVolume('enactment-deps-template-missing', newAttemptId(), 'agent', images),
      ).rejects.toThrow(DependencyVolumeError);
    });
  });

  it('keeps dependency writes out of a workspace snapshot', async () => {
    const workspace = await seedWorkspace();
    const depsVolume = await seedDeps(newAttemptId(), 'agent');

    await inWorkspace(workspace, depsVolume, [
      'sh',
      '-c',
      'touch /workspace/node_modules/.written-by-agent',
    ]);

    const store = new ArtifactStore(join(root, 'snapshots'));
    const snapshot = await snapshotWorkspace(workspace, store, images);
    const entries = (await readArchive(await store.read(snapshot.hash))).map((entry) => entry.path);

    expect(entries.filter((path) => path.includes('node_modules'))).toEqual([]);
  });
});
