import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RuntimeImages } from '../docker/images.js';
import { runContainer } from '../docker/run.js';
import { newAttemptId } from '../volume/naming.js';
import { createWorkspaceVolume, removeVolume, workspaceMount } from '../volume/workspace.js';

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

export const NODE_MODULES = 'node_modules';

/** Dependency snapshots keyed by the §12 cache key rather than by content. */
export class DependencyCache {
  constructor(private readonly root: string) {}

  pathFor(key: string): string {
    return join(this.root, `${createHash('sha256').update(key).digest('hex')}.tar`);
  }

  async has(key: string): Promise<boolean> {
    try {
      await readFile(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async put(key: string, bytes: Buffer): Promise<string> {
    const path = this.pathFor(key);
    await mkdir(this.root, { recursive: true });

    const staging = `${path}.staging`;
    await writeFile(staging, bytes);
    await rm(path, { force: true });
    await rename(staging, path);
    await chmod(path, 0o444);

    return path;
  }
}

export interface SetupOptions {
  cache: DependencyCache;
  key: string;
  attempt: string;
  /** Canonical export, used to give the install its manifest and lockfile. */
  workspaceTar: Buffer;
  installCommand: readonly string[];
  network: string;
  images: RuntimeImages;
}

export interface DependencyResult {
  key: string;
  path: string;
  cached: boolean;
  /** Install output, kept so a phase can record why an install behaved as it did. */
  output: string;
}

const CAPTURE_ARGV = [
  'tar',
  '--create',
  '--sort=name',
  '--numeric-owner',
  '--format=gnu',
  '--file',
  '-',
  '--directory',
  '/workspace',
  NODE_MODULES,
];

/**
 * Produce the dependency snapshot for a cache key, running the install only when the key is
 * cold. The setup container reaches the registry and nothing else: it is never given provider
 * credentials (DESIGN.md §5).
 */
export async function ensureDependencySnapshot(options: SetupOptions): Promise<DependencyResult> {
  if (await options.cache.has(options.key)) {
    return {
      key: options.key,
      path: options.cache.pathFor(options.key),
      cached: true,
      output: '',
    };
  }

  const volume = await createWorkspaceVolume(
    `${options.attempt}-setup-${newAttemptId()}`,
    options.workspaceTar,
    options.images,
  );

  try {
    const install = await runContainer({
      image: options.images.setup.reference,
      argv: [...options.installCommand],
      network: options.network,
      mounts: [workspaceMount(volume)],
    });

    if (install.exitCode !== 0) {
      throw new SetupError(
        `dependency install failed (${install.exitCode}): ${install.stderr || install.stdout}`,
      );
    }

    const capture = await runContainer({
      image: options.images.setup.reference,
      // An install that produced no packages still yields a valid, empty snapshot.
      argv: ['sh', '-c', `mkdir -p /workspace/${NODE_MODULES} && exec ${CAPTURE_ARGV.join(' ')}`],
      network: 'none',
      mounts: [workspaceMount(volume)],
    });

    if (capture.exitCode !== 0) {
      throw new SetupError(`dependency snapshot failed (${capture.exitCode}): ${capture.stderr}`);
    }

    // Written only after a successful install: a poisoned cache is worse than a slow one.
    const path = await options.cache.put(options.key, capture.stdoutBytes);

    return { key: options.key, path, cached: false, output: install.stdout };
  } finally {
    await removeVolume(volume);
  }
}
