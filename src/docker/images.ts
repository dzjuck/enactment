import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import { IMAGE_PINS, IMAGE_ROLES, type ImagePin, type ImageRole } from '../config/pins.js';

export class ImagePinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImagePinError';
  }
}

/** Injectable so pin verification is testable without a daemon. Returns stdout. */
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

export async function resolveDigest(ref: string, exec: DockerExec = dockerExec): Promise<string> {
  const digest = await exec(['image', 'inspect', '--format', '{{.Id}}', ref]);
  return digest.trim();
}

export interface ResolveImageDigestsOptions {
  pins?: Record<ImageRole, ImagePin>;
  exec?: DockerExec;
}

/**
 * Resolve every runtime image to a digest, refusing any that differs from its pin.
 * Nothing is started here: an unpinned image never becomes a runnable reference.
 */
export async function resolveImageDigests({
  pins = IMAGE_PINS,
  exec = dockerExec,
}: ResolveImageDigestsOptions = {}): Promise<Record<ImageRole, string>> {
  const digests = {} as Record<ImageRole, string>;

  for (const role of IMAGE_ROLES) {
    const pin = pins[role];
    const resolved = await resolveDigest(pin.tag, exec);

    if (pin.digest !== undefined && pin.digest !== resolved) {
      throw new ImagePinError(
        `image ${role} (${pin.tag}) resolved to ${resolved}, but is pinned to ${pin.digest}`,
      );
    }

    digests[role] = resolved;
  }

  return digests;
}
