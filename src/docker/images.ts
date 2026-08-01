import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import {
  BUILT_IMAGE_PINS,
  IMAGE_PINS,
  IMAGE_ROLES,
  SUPPORTED_PLATFORMS,
  type ImageRole,
} from '../config/pins.js';

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

/** The image ID. Recorded for traceability; it is not the pin — see `resolveContentDigest`. */
export async function resolveDigest(ref: string, exec: DockerExec = dockerExec): Promise<string> {
  const digest = await exec(['image', 'inspect', '--format', '{{.Id}}', ref]);
  return digest.trim();
}

/**
 * Content identity: a hash over the image's filesystem layers **and** its config.
 *
 * The image ID cannot serve as a pin. BuildKit stamps a fresh creation timestamp into the
 * image config on every `docker build`, so the ID changes even when a fully cached rebuild
 * produced byte-identical layers — measured, not assumed.
 *
 * Layers alone are not enough either: `ENV`, `USER`, `WORKDIR` and `ENTRYPOINT` create no
 * filesystem layer, so the verifier and setup images have identical layer sets and would
 * collide. Config is where `USER 1001` and the cleared entrypoint live, so it is pinned too.
 * `.Created` sits outside `.Config` and is deliberately excluded.
 */
export async function resolveContentDigest(
  ref: string,
  exec: DockerExec = dockerExec,
): Promise<string> {
  const identity = await exec([
    'image',
    'inspect',
    '--format',
    '{{json .RootFS.Layers}}{{json .Config}}',
    ref,
  ]);

  return `sha256:${createHash('sha256').update(identity.trim()).digest('hex')}`;
}

/** `linux/arm64`, `linux/amd64` — the identity that selects a built-image pin set. */
export async function resolveDockerPlatform(exec: DockerExec = dockerExec): Promise<string> {
  const platform = await exec(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}']);
  return platform.trim();
}

export interface ResolveImageDigestsOptions {
  /** The digest table for the platform; defaults to the committed pins. */
  pins?: Record<ImageRole, string>;
  platform?: string;
  exec?: DockerExec;
}

/**
 * Resolve every runtime image to a digest and refuse anything that is not exactly its pin.
 *
 * The pin table is validated first, so a missing or unsupported entry is a configuration
 * error reported before a single image is inspected — an unpinned image never becomes a
 * runnable reference.
 */
export async function resolveImageDigests({
  pins,
  platform,
  exec = dockerExec,
}: ResolveImageDigestsOptions = {}): Promise<Record<ImageRole, string>> {
  const target = platform ?? (await resolveDockerPlatform(exec));

  const table = pins ?? BUILT_IMAGE_PINS[target];
  if (table === undefined) {
    throw new ImagePinError(
      `unsupported Docker server platform "${target}": no built-image pins are committed for it ` +
        `(supported: ${SUPPORTED_PLATFORMS.join(', ')})`,
    );
  }

  for (const role of IMAGE_ROLES) {
    const pinned = table[role];
    if (pinned === undefined || pinned === '') {
      throw new ImagePinError(`no built-image digest pinned for ${role} on ${target}`);
    }
  }

  const digests = {} as Record<ImageRole, string>;

  for (const role of IMAGE_ROLES) {
    const pin = IMAGE_PINS[role];
    const pinned = table[role] ?? '';
    const resolved = await resolveContentDigest(pin.tag, exec);

    if (pinned !== resolved) {
      throw new ImagePinError(
        `image ${role} (${pin.tag}) has content digest ${resolved}, but is pinned to ${pinned}`,
      );
    }

    digests[role] = resolved;
  }

  return digests;
}
