import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IMAGE_PINS } from '../../src/config/pins.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { exportCommit } from '../../src/git/export.js';
import { runContainer, type RunResult } from '../../src/docker/run.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { initSyntheticGit, SYNTHETIC_COMMIT_SUBJECT } from '../../src/volume/synthetic-git.js';
import { createWorkspaceVolume, removeVolume, workspaceMount } from '../../src/volume/workspace.js';
import { runtimeImages } from '../helpers/images.js';
import { createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';

let repo: TargetRepo;
let tar: Buffer;
let volume: string;
let images: RuntimeImages;
const created: string[] = [];

async function seed(): Promise<string> {
  const name = await createWorkspaceVolume(newAttemptId(), tar, images);
  created.push(name);
  return name;
}

function inWorkspace(name: string, argv: string[], env?: Record<string, string>): Promise<RunResult> {
  return runContainer({
    image: IMAGE_PINS.agent.tag,
    argv,
    network: 'none',
    mounts: [workspaceMount(name)],
    ...(env === undefined ? {} : { env }),
  });
}

beforeAll(async () => {
  images = await runtimeImages();
  repo = await createTargetRepo();
  ({ tar } = await exportCommit(repo.dir, repo.commit));
  volume = await seed();
  await initSyntheticGit(volume, images);
});

afterAll(async () => {
  await Promise.all(created.splice(0).map((name) => removeVolume(name)));
  await removeRepo(repo.dir);
});

describe('synthetic git', () => {
  it('has exactly one commit', async () => {
    const result = await inWorkspace(volume, ['git', 'rev-list', '--count', 'HEAD']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1');
  });

  it('names that commit the synthetic baseline', async () => {
    const result = await inWorkspace(volume, ['git', 'log', '-1', '--format=%s']);

    expect(result.stdout.trim()).toBe(SYNTHETIC_COMMIT_SUBJECT);
  });

  it('committed everything: the working tree is clean', async () => {
    const result = await inWorkspace(volume, ['git', 'status', '--porcelain']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('has no remotes', async () => {
    const result = await inWorkspace(volume, ['git', 'remote', '-v']);

    expect(result.stdout).toBe('');
  });

  it('exposes no canonical history: the base commit SHA is nowhere in the workspace', async () => {
    const result = await inWorkspace(volume, [
      'grep',
      '--recursive',
      '--fixed-strings',
      repo.commit,
      '/workspace',
    ]);

    expect(result.stdout).toBe('');
    expect(result.exitCode).not.toBe(0);
  });

  it('did not run the repository pre-commit hook', async () => {
    const marker = await inWorkspace(volume, ['sh', '-c', 'test -e /workspace/HOOK_RAN']);

    expect(marker.exitCode).not.toBe(0);
  });

  it('control: the same hook does run when hooksPath is not neutralized', async () => {
    const other = await seed();

    const result = await inWorkspace(
      other,
      [
        'sh',
        '-c',
        'git init -q -b main . && git add -A && ' +
          'git -c core.hooksPath=/workspace/.githooks commit -q -m probe',
      ],
      {
        GIT_AUTHOR_NAME: 'probe',
        GIT_AUTHOR_EMAIL: 'probe@localhost',
        GIT_COMMITTER_NAME: 'probe',
        GIT_COMMITTER_EMAIL: 'probe@localhost',
      },
    );

    expect(result.exitCode).not.toBe(0);
    await expect(
      inWorkspace(other, ['sh', '-c', 'test -e /workspace/HOOK_RAN']).then((run) => run.exitCode),
    ).resolves.toBe(0);
  });

  it('supports git describe, the reason synthetic git exists', async () => {
    const result = await inWorkspace(volume, ['git', 'describe', '--always']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('configures no credential helper and leaves no .netrc', async () => {
    const helper = await inWorkspace(volume, ['git', 'config', '--get', 'credential.helper']);
    const netrc = await inWorkspace(volume, [
      'sh',
      '-c',
      'ls -A /home/agent/.netrc /workspace/.netrc 2>/dev/null',
    ]);

    expect(helper.exitCode).not.toBe(0);
    expect(helper.stdout).toBe('');
    expect(netrc.stdout).toBe('');
  });
});
