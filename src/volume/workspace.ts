import { execa } from 'execa';

import type { Mount } from '../docker/args.js';
import type { RuntimeImages } from '../docker/images.js';
import { runContainer } from '../docker/run.js';
import { attemptLabels, workspaceVolumeName } from './naming.js';

export class WorkspaceVolumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceVolumeError';
  }
}

export const WORKSPACE_PATH = '/workspace';

export function workspaceMount(name: string): Mount {
  return { type: 'volume', source: name, target: WORKSPACE_PATH };
}

export async function volumeExists(name: string): Promise<boolean> {
  const { exitCode } = await execa('docker', ['volume', 'inspect', name], { reject: false });
  return exitCode === 0;
}

/** Removing a volume that is not there is success, not an error. */
export async function removeVolume(name: string): Promise<void> {
  await execa('docker', ['volume', 'rm', '--force', name], { reject: false });
}

export async function createVolume(name: string, labels: Record<string, string>): Promise<void> {
  const flags = Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  await execa('docker', ['volume', 'create', ...flags, name]);
}

/**
 * Create an attempt-scoped workspace volume and seed it from a canonical export.
 *
 * The volume is populated by a helper container rather than from the host: a fresh named
 * volume inherits the ownership of the image's mount point (uid/gid 1001), so nothing here
 * needs root.
 */
export async function createWorkspaceVolume(
  attempt: string,
  tar: Buffer,
  images: RuntimeImages,
  /**
   * The attempt whose label the volume carries. Defaults to `attempt`; a caller that scopes
   * the *name* to a sub-phase passes the root attempt here, so the attempt-label sweep can
   * still find the volume. A label nobody sweeps for is not a label.
   */
  owner: string = attempt,
): Promise<string> {
  const name = workspaceVolumeName(attempt);

  if (await volumeExists(name)) {
    throw new WorkspaceVolumeError(`workspace volume ${name} already exists`);
  }

  await createVolume(name, attemptLabels(owner, 'workspace'));

  try {
    const result = await runContainer(
      {
        image: images.setup.id,
        argv: [
          'tar',
          '--extract',
          '--preserve-permissions',
          '--file',
          '-',
          '--directory',
          WORKSPACE_PATH,
        ],
        network: 'none',
        mounts: [workspaceMount(name)],
        labels: attemptLabels(owner, 'seed'),
      },
      { input: tar },
    );

    if (result.exitCode !== 0) {
      throw new WorkspaceVolumeError(`seeding ${name} failed (${result.exitCode}): ${result.stderr}`);
    }
  } catch (error) {
    await removeVolume(name);
    throw error;
  }

  return name;
}
