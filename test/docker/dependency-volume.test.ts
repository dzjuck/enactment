import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../src/artifacts/store.js';
import { IMAGE_PINS } from '../../src/config/pins.js';
import { DependencyCache, ensureDependencySnapshot } from '../../src/deps/setup.js';
import { createDependencyVolume, dependencyMount } from '../../src/deps/volume.js';
import { runContainer, type RunResult } from '../../src/docker/run.js';
import { exportCommit } from '../../src/git/export.js';
import { dependencyVolumeName, newAttemptId } from '../../src/volume/naming.js';
import { snapshotWorkspace } from '../../src/volume/snapshot.js';
import {
  createWorkspaceVolume,
  removeVolume,
  volumeExists,
  workspaceMount,
} from '../../src/volume/workspace.js';
import { createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { readTar } from '../helpers/tar.js';

const KEY = 'sha256:dependency-volume-tests';

let repo: TargetRepo;
let tar: Buffer;
let deps: Buffer;
let root: string;
const created: string[] = [];

beforeAll(async () => {
  repo = await createTargetRepo();
  ({ tar } = await exportCommit(repo.dir, repo.commit));

  root = await mkdtemp(join(tmpdir(), 'harness-depvol-'));
  const cache = new DependencyCache(root);
  await ensureDependencySnapshot({
    cache,
    key: KEY,
    attempt: newAttemptId(),
    workspaceTar: tar,
    installCommand: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    network: 'bridge',
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
  const name = await createWorkspaceVolume(newAttemptId(), tar);
  created.push(name);
  return name;
}

async function seedDeps(attempt: string, phase: string): Promise<string> {
  const name = await createDependencyVolume(attempt, phase, deps);
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

  it('keeps dependency writes out of a workspace snapshot', async () => {
    const workspace = await seedWorkspace();
    const depsVolume = await seedDeps(newAttemptId(), 'agent');

    await inWorkspace(workspace, depsVolume, [
      'sh',
      '-c',
      'touch /workspace/node_modules/.written-by-agent',
    ]);

    const store = new ArtifactStore(join(root, 'snapshots'));
    const snapshot = await snapshotWorkspace(workspace, store);
    const entries = readTar(await store.read(snapshot.hash)).map((entry) => entry.path);

    expect(entries.filter((path) => path.includes('node_modules'))).toEqual([]);
  });
});
