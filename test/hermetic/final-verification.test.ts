import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../src/artifacts/store.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { FinalVerificationError, verifyPlanHead } from '../../src/verify/final.js';
import { createM2Repo, removeRepo, type TargetRepo } from '../helpers/repo.js';

const IMAGES: RuntimeImages = {
  agent: { role: 'agent', id: `sha256:${'a'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'b'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'c'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'d'.repeat(64)}` },
};

const dirs: string[] = [];
const repos: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(repos.splice(0).map((dir) => removeRepo(dir)));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-final-'));
  dirs.push(dir);
  return dir;
}

async function repository(): Promise<TargetRepo> {
  const repo = await createM2Repo();
  repos.push(repo.dir);
  return repo;
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
}

describe('final branch verification preconditions', () => {
  it('refuses an empty command set before creating any verifier resource', async () => {
    const repo = await repository();
    const artifactDir = await scratch();
    const snapshotDir = await scratch();

    const error = await verifyPlanHead({
      repoPath: repo.dir,
      head: repo.commit,
      commands: [],
      artifactDir,
      snapshots: new ArtifactStore(snapshotDir),
      images: IMAGES,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FinalVerificationError);
    expect((error as Error).message).toMatch(/command/i);
    expect(await entries(artifactDir)).toEqual([]);
    expect(await entries(snapshotDir)).toEqual([]);
  });

  it('refuses a head the repository cannot resolve before creating any verifier resource', async () => {
    const repo = await repository();
    const artifactDir = await scratch();
    const snapshotDir = await scratch();

    const error = await verifyPlanHead({
      repoPath: repo.dir,
      head: 'f'.repeat(40),
      commands: [['node', '--version']],
      artifactDir,
      snapshots: new ArtifactStore(snapshotDir),
      images: IMAGES,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FinalVerificationError);
    expect((error as Error).message).toContain('f'.repeat(40));
    expect(await entries(artifactDir)).toEqual([]);
    expect(await entries(snapshotDir)).toEqual([]);
  });
});
