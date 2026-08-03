import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { execa } from 'execa';

import { ArtifactStore } from '../artifacts/store.js';
import { dependencyCacheKey, installCommand, lockfileHash } from '../deps/cache-key.js';
import { DependencyCache, ensureDependencySnapshot } from '../deps/setup.js';
import type { RuntimeImages } from '../docker/images.js';
import { exportCommit } from '../git/export.js';
import { withPhaseNetworks } from '../net/manage.js';
import { CleanupError, describeError, sweepAttempt } from '../run/cleanup.js';
import { OwnershipError } from '../run/ownership.js';
import { runtimeSection, type RuntimeSection } from '../run/manifest.js';
import { stateDirectory } from '../state/paths.js';
import { CONTRACT_TIMEOUTS } from '../run/timeout.js';
import { newAttemptId } from '../volume/naming.js';
import { runVerification, type CommandResult } from './run.js';

export class FinalVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinalVerificationError';
  }
}

export const FINAL_VERIFICATION_ARTIFACT = 'final-verification.json';

export interface FinalVerificationOptions {
  repoPath: string;
  /** The recorded plan branch head. Nothing here reads a ref: the commit is supplied. */
  head: string;
  /** Fixed argument arrays from `final_verification.commands` (§16). */
  commands: readonly (readonly string[])[];
  artifactDir: string;
  /** Plan-scoped store; the exported head is kept beside the attempts' snapshots. */
  snapshots: ArtifactStore;
  images: RuntimeImages;
  dependencyCacheDirectory?: string;
  /** Scopes the Docker labels and volume names of this verification run. */
  attempt?: string;
  timeoutSeconds?: number;
  setupSeconds?: number;
  graceSeconds?: number;
  signal?: AbortSignal;
}

export interface FinalVerificationResult {
  status: 'pass' | 'fail' | 'timeout';
  head: string;
  commands: CommandResult[];
  dependencyCacheKey: string;
  exportHash: string;
  runtime: RuntimeSection;
  /** Resources this run could not release. Absent when everything was released. */
  cleanupErrors?: string[];
}

async function resolves(repoPath: string, commit: string): Promise<boolean> {
  const { exitCode } = await execa('git', ['-C', repoPath, 'cat-file', '-e', `${commit}^{commit}`], {
    reject: false,
  });
  return exitCode === 0;
}

/**
 * Verify a finished plan branch head offline, on a disposable copy, with clean dependencies.
 *
 * It composes the pieces the step pipeline already uses — export, artifact store, dependency
 * setup, disposable verification — rather than adding a second verifier. What is different is
 * only the input: an accepted commit rather than an implementation snapshot, so the thing
 * being verified is the branch a human will review.
 *
 * Nothing here can change the branch. The verifier has no network, no provider credential and
 * no canonical `.git`; it works on a copy of an export, and the copy is destroyed.
 */
export async function verifyPlanHead(
  options: FinalVerificationOptions,
): Promise<FinalVerificationResult> {
  // Both checks precede every resource: a plan that declared no commands, or a head that no
  // longer resolves, is an input error and must not cost a container.
  if (options.commands.length === 0) {
    throw new FinalVerificationError(
      'final verification declared no commands; a plan must say how its branch is verified',
    );
  }
  if (!(await resolves(options.repoPath, options.head))) {
    throw new FinalVerificationError(
      `final head ${options.head} does not resolve in ${options.repoPath}`,
    );
  }

  const attempt = options.attempt ?? newAttemptId();
  const graceSeconds = options.graceSeconds ?? CONTRACT_TIMEOUTS.termination_grace_seconds;

  const aborted = (): void => {
    if (options.signal?.aborted === true) {
      throw new FinalVerificationError('final verification was interrupted');
    }
  };

  let outcome: { value: FinalVerificationResult } | { error: unknown };

  try {
    aborted();
    const { tar, hash: exportHash } = await exportCommit(options.repoPath, options.head);
    const snapshot = await options.snapshots.put(tar, '.tar');

    const install = installCommand('denied');
    const cacheKey = dependencyCacheKey({
      setupImageId: options.images.setup.id,
      lockfileHash: await lockfileHash(options.repoPath, options.head),
      installCommand: install,
      lifecycleScripts: 'denied',
    });

    aborted();
    const cache = new DependencyCache(
      options.dependencyCacheDirectory ?? join(stateDirectory(), 'dependency-cache'),
    );
    await withPhaseNetworks(attempt, 'setup', (networks) =>
      ensureDependencySnapshot({
        cache,
        key: cacheKey,
        attempt,
        workspaceTar: tar,
        installCommand: install,
        network: networks.registry ?? 'none',
        images: options.images,
        setupSeconds: options.setupSeconds ?? CONTRACT_TIMEOUTS.setup_seconds,
        graceSeconds,
      }),
    );

    aborted();
    const verification = await runVerification({
      attempt,
      snapshot,
      dependencySnapshot: await cache.read(cacheKey),
      commands: options.commands,
      artifactDir: options.artifactDir,
      images: options.images,
      ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
      graceSeconds,
    });

    outcome = {
      value: {
        status: verification.status,
        head: options.head,
        commands: verification.commands,
        dependencyCacheKey: cacheKey,
        exportHash,
        runtime: runtimeSection(options.images),
      },
    };
  } catch (error) {
    outcome = { error };
  }

  // Every helper releases what it created; this reaches what a failure part-way through
  // could not, and is reported rather than swallowed.
  const cleanupErrors: string[] = [];
  try {
    await sweepAttempt(attempt);
  } catch (error) {
    cleanupErrors.push(...(error instanceof CleanupError ? error.errors : [describeError(error)]));
  }

  if ('error' in outcome) {
    if (cleanupErrors.length > 0) {
      throw new OwnershipError(
        `final verification ${attempt}`,
        outcome.error,
        new CleanupError(cleanupErrors),
      );
    }

    throw outcome.error;
  }

  const result: FinalVerificationResult =
    cleanupErrors.length === 0 ? outcome.value : { ...outcome.value, cleanupErrors };

  await mkdir(options.artifactDir, { recursive: true });
  await writeFile(
    join(options.artifactDir, FINAL_VERIFICATION_ARTIFACT),
    `${JSON.stringify(result, null, 2)}\n`,
  );

  return result;
}
