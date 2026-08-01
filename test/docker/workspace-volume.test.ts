import { createHash } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { IMAGE_PINS } from '../../src/config/pins.js';
import { exportCommit } from '../../src/git/export.js';
import { runContainer } from '../../src/docker/run.js';
import { newAttemptId, workspaceVolumeName } from '../../src/volume/naming.js';
import {
  WorkspaceVolumeError,
  createWorkspaceVolume,
  removeVolume,
  volumeExists,
  workspaceMount,
} from '../../src/volume/workspace.js';
import { createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { readTar } from '../../src/artifacts/tar.js';

let repo: TargetRepo;
let tar: Buffer;
const created: string[] = [];

beforeAll(async () => {
  repo = await createTargetRepo();
  ({ tar } = await exportCommit(repo.dir, repo.commit));
});

afterAll(async () => {
  await removeRepo(repo.dir);
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((name) => removeVolume(name)));
});

async function seed(): Promise<string> {
  const name = await createWorkspaceVolume(newAttemptId(), tar);
  created.push(name);
  return name;
}

async function inWorkspace(name: string, argv: string[]) {
  return runContainer({
    image: IMAGE_PINS.agent.tag,
    argv,
    network: 'none',
    mounts: [workspaceMount(name)],
  });
}

describe('workspace volume', () => {
  it('exposes the exported tree at /workspace', async () => {
    const name = await seed();

    const result = await inWorkspace(name, ['sh', '-c', 'find /workspace -mindepth 1 | sort']);
    const found = result.stdout.split('\n').map((line) => line.replace('/workspace/', ''));

    expect(result.exitCode).toBe(0);
    expect(found).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        'README.md',
        'package.json',
        'src/slugify.js',
        'test/slugify.test.js',
        'vitest.config.js',
      ]),
    );
    expect(found).not.toContain('policy.rules');
  });

  it('seeds file contents byte for byte', async () => {
    const name = await seed();

    const result = await inWorkspace(name, ['sha256sum', '/workspace/src/slugify.js']);
    const exported = readTar(tar).find((entry) => entry.path === 'src/slugify.js');

    expect(result.stdout.split(' ')[0]).toBe(
      createHash('sha256').update(exported?.content ?? Buffer.alloc(0)).digest('hex'),
    );
  });

  it('preserves executable bits and symlinks', async () => {
    const name = await seed();

    const executable = await inWorkspace(name, [
      'sh',
      '-c',
      'test -x /workspace/.githooks/pre-commit',
    ]);
    const link = await inWorkspace(name, ['readlink', '/workspace/docs/readme.md']);

    expect(executable.exitCode).toBe(0);
    expect(link.stdout.trim()).toBe('../README.md');
  });

  it('is attempt-scoped and isolated across concurrent attempts', async () => {
    const [first, second] = await Promise.all([seed(), seed()]);

    expect(first).not.toBe(second);
    expect(first).toContain('ai-harness');

    await inWorkspace(first, ['sh', '-c', 'echo mutated > /workspace/README.md']);

    const untouched = await inWorkspace(second, ['cat', '/workspace/README.md']);
    expect(untouched.stdout).toContain('target-repo');
  });

  it('refuses to seed a volume name that already exists', async () => {
    const attempt = newAttemptId();
    created.push(workspaceVolumeName(attempt));

    await createWorkspaceVolume(attempt, tar);
    await expect(createWorkspaceVolume(attempt, tar)).rejects.toThrow(WorkspaceVolumeError);
  });

  it('removes a volume, and removing a missing one is a no-op', async () => {
    const name = await seed();

    await removeVolume(name);
    await expect(volumeExists(name)).resolves.toBe(false);
    await expect(removeVolume(name)).resolves.toBeUndefined();
  });

  it('is writable by the agent despite the read-only root filesystem', async () => {
    const name = await seed();

    const write = await inWorkspace(name, ['sh', '-c', 'touch /workspace/agent-wrote']);
    const root = await inWorkspace(name, ['sh', '-c', 'touch /denied']);

    expect(write.exitCode).toBe(0);
    expect(root.exitCode).not.toBe(0);
  });
});
