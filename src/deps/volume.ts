import { IMAGE_PINS } from '../config/pins.js';
import type { Mount } from '../docker/args.js';
import { runContainer } from '../docker/run.js';
import { attemptLabels, dependencyVolumeName } from '../volume/naming.js';
import { WORKSPACE_PATH, createVolume, removeVolume, volumeExists } from '../volume/workspace.js';
import { NODE_MODULES } from './setup.js';

export class DependencyVolumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyVolumeError';
  }
}

export const DEPENDENCY_PATH = `${WORKSPACE_PATH}/${NODE_MODULES}`;

export function dependencyMount(name: string): Mount {
  return { type: 'volume', source: name, target: DEPENDENCY_PATH };
}

/**
 * Seed a writable, phase-scoped dependency volume from a cached snapshot (§12).
 *
 * Seeding mounts the volume at `/workspace` rather than at its eventual nested path: a fresh
 * volume takes its ownership from the image's mount point, and `/workspace` is the directory
 * the images actually own. The snapshot's `node_modules/` prefix is stripped so the volume's
 * root is the package tree itself.
 */
export async function createDependencyVolume(
  attempt: string,
  phase: string,
  snapshot: Buffer,
): Promise<string> {
  const name = dependencyVolumeName(attempt, phase);

  if (await volumeExists(name)) {
    throw new DependencyVolumeError(`dependency volume ${name} already exists`);
  }

  await createVolume(name, attemptLabels(attempt, `deps-${phase}`));

  try {
    const result = await runContainer(
      {
        image: IMAGE_PINS.setup.tag,
        argv: [
          'tar',
          '--extract',
          '--preserve-permissions',
          '--strip-components=1',
          '--file',
          '-',
          '--directory',
          WORKSPACE_PATH,
        ],
        network: 'none',
        mounts: [{ type: 'volume', source: name, target: WORKSPACE_PATH }],
        labels: attemptLabels(attempt, `deps-${phase}-seed`),
      },
      { input: snapshot },
    );

    if (result.exitCode !== 0) {
      throw new DependencyVolumeError(
        `seeding ${name} failed (${result.exitCode}): ${result.stderr}`,
      );
    }
  } catch (error) {
    await removeVolume(name);
    throw error;
  }

  return name;
}
