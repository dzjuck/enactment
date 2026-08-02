import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import { IMAGE_PINS, IMAGE_ROLES, type ImageRole } from '../config/pins.js';

export class RuntimeImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeImageError';
  }
}

/** Injectable so runtime resolution is testable without a daemon. Returns stdout. */
export type DockerExec = (args: string[]) => Promise<string>;

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const dockerExec: DockerExec = async (args) => {
  const { stdout } = await execa('docker', args, { cwd: REPO_ROOT });
  return stdout;
};

export async function buildImage(role: ImageRole, exec: DockerExec = dockerExec): Promise<string> {
  const pin = IMAGE_PINS[role];
  const buildArgs = Object.entries(pin.buildArgs).flatMap(([key, value]) => [
    '--build-arg',
    `${key}=${value}`,
  ]);

  const dockerfile = pin.dockerfile === undefined ? [] : ['--file', pin.dockerfile];

  await exec(['build', ...buildArgs, ...dockerfile, '--tag', pin.tag, pin.context]);
  return pin.tag;
}

/** Build every runtime image. The operator entry point behind `npm run images:build`. */
export async function buildAllImages(exec: DockerExec = dockerExec): Promise<string[]> {
  const tags: string[] = [];
  for (const role of IMAGE_ROLES) tags.push(await buildImage(role, exec));
  return tags;
}

/**
 * The immutable Docker image ID a tag currently points at.
 *
 * Tags are build aliases and can be reassigned at any moment; the ID cannot. Resolving once
 * and then running the ID is what makes "what ran" and "what was recorded" the same value,
 * even if something rebuilds the tag mid-run.
 */
export async function resolveImageId(ref: string, exec: DockerExec = dockerExec): Promise<string> {
  const id = await exec(['image', 'inspect', '--format', '{{.Id}}', ref]);
  return id.trim();
}

/** One role's runtime identity: the image ID every container of that role is started from. */
export interface RuntimeImage {
  role: ImageRole;
  id: string;
}

export type RuntimeImages = Record<ImageRole, RuntimeImage>;

export interface ResolveRuntimeImagesOptions {
  exec?: DockerExec;
}

/**
 * Resolve the four runtime tags to image IDs, once, before anything is started.
 *
 * V1 trusts the local Docker daemon: the Dockerfiles, the base-image digest and the tool
 * versions are pinned in source, and an explicit build produces the local images. What must
 * not happen is a run drifting between images mid-flight, which resolving up front prevents.
 *
 * A tag that does not resolve means the images were never built here, so the error says how
 * to build them rather than reporting a raw `docker image inspect` failure.
 */
export async function resolveRuntimeImages({
  exec = dockerExec,
}: ResolveRuntimeImagesOptions = {}): Promise<RuntimeImages> {
  const images = {} as RuntimeImages;

  for (const role of IMAGE_ROLES) {
    const { tag } = IMAGE_PINS[role];

    let id: string;
    try {
      id = await resolveImageId(tag, exec);
    } catch (error) {
      throw new RuntimeImageError(
        `runtime image ${role} (${tag}) is not available locally: ` +
          `run \`npm run images:build\` to build it (${describe(error)})`,
      );
    }

    if (id === '') {
      throw new RuntimeImageError(
        `runtime image ${role} (${tag}) resolved to no image ID: ` +
          'run `npm run images:build` to build it',
      );
    }

    images[role] = { role, id };
  }

  return images;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
