import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RuntimeImages } from '../docker/images.js';
import { runContainer } from '../docker/run.js';
import { PhaseFailure } from '../run/failure.js';
import { CONTRACT_TIMEOUTS } from '../run/timeout.js';
import { attemptLabels, newAttemptId } from '../volume/naming.js';
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

    // Staged under a unique name because the cache directory is shared: two installs of the
    // same lockfile running at once would otherwise interleave their bytes in one staging
    // file and rename the result into place. Every writer produces identical content, so the
    // rename staying atomic is all the ordering this needs.
    const staging = `${path}.${randomUUID()}.staging`;
    try {
      await writeFile(staging, bytes);
      await rm(path, { force: true });
      await rename(staging, path);
    } finally {
      await rm(staging, { force: true });
    }
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
  /** The install's budget (§5). Defaults to the contract; a task may lower it. */
  setupSeconds?: number;
  graceSeconds?: number;
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
    options.attempt,
  );

  try {
    // The install reaches the network, so it can hang exactly the way the agent can. It
    // consumes the §5 ladder rather than running unbounded until the whole run is abandoned.
    const install = await runContainer(
      {
        image: options.images.setup.id,
        argv: [...options.installCommand],
        network: options.network,
        mounts: [workspaceMount(volume)],
        labels: attemptLabels(options.attempt, 'setup'),
      },
      {
        timeoutSeconds: options.setupSeconds ?? CONTRACT_TIMEOUTS.setup_seconds,
        graceSeconds: options.graceSeconds ?? CONTRACT_TIMEOUTS.termination_grace_seconds,
      },
    );

    // Distinct from a completed non-zero install: one is a budget overrun, the other is a
    // real answer from the package manager, and they call for different responses.
    if (install.status === 'timeout') {
      throw new PhaseFailure(
        'setup',
        'setup_timeout',
        `dependency install exceeded ${String(
          options.setupSeconds ?? CONTRACT_TIMEOUTS.setup_seconds,
        )}s and was terminated`,
      );
    }

    if (install.exitCode !== 0) {
      throw new SetupError(
        `dependency install failed (${install.exitCode}): ${install.stderr || install.stdout}`,
      );
    }

    const capture = await runContainer({
      image: options.images.setup.id,
      // An install that produced no packages still yields a valid, empty snapshot.
      argv: ['sh', '-c', `mkdir -p /workspace/${NODE_MODULES} && exec ${CAPTURE_ARGV.join(' ')}`],
      network: 'none',
      mounts: [workspaceMount(volume)],
      labels: attemptLabels(options.attempt, 'setup-capture'),
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
