import type { Mount } from '../docker/args.js';
import type { RuntimeImages } from '../docker/images.js';
import { runContainer } from '../docker/run.js';
import {
  attemptLabels,
  dependencyTemplateVolumeName,
  dependencyVolumeName,
} from '../volume/naming.js';
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

/** Where the template is mounted, read-only, while a clone is filled from it. */
const TEMPLATE_PATH = '/template';

/**
 * Seed the attempt's dependency template once, from the cached snapshot.
 *
 * The snapshot is a tar the host holds in memory, so extracting it costs a full transfer
 * across the Docker API — for a real `node_modules` that is tens of megabytes, and the earlier
 * shape paid it once per phase (agent, baseline, RED, GREEN, final). Paying it once and
 * copying inside the VM keeps §12's guarantee, which is about *isolation* between phases, not
 * about where the bytes came from.
 */
export async function createDependencyTemplate(
  attempt: string,
  snapshot: Buffer,
  images: RuntimeImages,
  owner: string = attempt,
): Promise<string> {
  const name = dependencyTemplateVolumeName(attempt);

  if (await volumeExists(name)) {
    throw new DependencyVolumeError(`dependency template ${name} already exists`);
  }

  await createVolume(name, attemptLabels(owner, 'deps-template'));

  try {
    await extractSnapshot(name, snapshot, images, attemptLabels(owner, 'deps-template-seed'));
  } catch (error) {
    await removeVolume(name);
    throw error;
  }

  return name;
}

/**
 * Fill a fresh phase volume from the attempt's template.
 *
 * The template is mounted read-only, so a phase cannot contaminate what later phases are
 * seeded from — the property the per-phase volumes exist to provide.
 */
export async function cloneDependencyVolume(
  template: string,
  attempt: string,
  phase: string,
  images: RuntimeImages,
  owner: string = attempt,
): Promise<string> {
  if (!(await volumeExists(template))) {
    throw new DependencyVolumeError(`dependency template ${template} does not exist`);
  }

  const name = dependencyVolumeName(attempt, phase);

  if (await volumeExists(name)) {
    throw new DependencyVolumeError(`dependency volume ${name} already exists`);
  }

  await createVolume(name, attemptLabels(owner, `deps-${phase}`));

  try {
    const result = await runContainer({
      image: images.setup.id,
      // `.` rather than `*`: dotfiles are part of a dependency tree (`.bin`, `.package-lock`).
      argv: ['cp', '-a', `${TEMPLATE_PATH}/.`, `${WORKSPACE_PATH}/`],
      network: 'none',
      mounts: [
        { type: 'volume', source: template, target: TEMPLATE_PATH, readonly: true },
        { type: 'volume', source: name, target: WORKSPACE_PATH },
      ],
      labels: attemptLabels(owner, `deps-${phase}-clone`),
    });

    if (result.exitCode !== 0) {
      throw new DependencyVolumeError(
        `cloning ${template} into ${name} failed (${result.exitCode}): ${result.stderr}`,
      );
    }
  } catch (error) {
    await removeVolume(name);
    throw error;
  }

  return name;
}

/**
 * Extraction mounts the volume at `/workspace` rather than at its eventual nested path: a
 * fresh volume takes its ownership from the image's mount point, and `/workspace` is the
 * directory the images actually own. The snapshot's `node_modules/` prefix is stripped so the
 * volume's root is the package tree itself.
 */
async function extractSnapshot(
  volume: string,
  snapshot: Buffer,
  images: RuntimeImages,
  labels: Record<string, string>,
): Promise<void> {
  const result = await runContainer(
    {
      image: images.setup.id,
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
      mounts: [{ type: 'volume', source: volume, target: WORKSPACE_PATH }],
      labels,
    },
    { input: snapshot },
  );

  if (result.exitCode !== 0) {
    throw new DependencyVolumeError(
      `seeding ${volume} failed (${result.exitCode}): ${result.stderr}`,
    );
  }
}

/**
 * Seed a writable, phase-scoped dependency volume directly from a cached snapshot (§12).
 *
 * The one-off path, for a caller that holds a snapshot and needs a single volume. A run that
 * needs several seeds one template and clones it instead.
 */
export async function createDependencyVolume(
  attempt: string,
  phase: string,
  snapshot: Buffer,
  images: RuntimeImages,
  /** The attempt whose label the volume carries; see `createWorkspaceVolume`. */
  owner: string = attempt,
): Promise<string> {
  const name = dependencyVolumeName(attempt, phase);

  if (await volumeExists(name)) {
    throw new DependencyVolumeError(`dependency volume ${name} already exists`);
  }

  await createVolume(name, attemptLabels(owner, `deps-${phase}`));

  try {
    await extractSnapshot(name, snapshot, images, attemptLabels(owner, `deps-${phase}-seed`));
  } catch (error) {
    await removeVolume(name);
    throw error;
  }

  return name;
}
