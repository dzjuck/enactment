import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StoredArtifact } from '../artifacts/store.js';
import { createDependencyVolume, dependencyMount } from '../deps/volume.js';
import type { RuntimeImages } from '../docker/images.js';
import { runContainer, type RunStatus } from '../docker/run.js';
import { CleanupError, releaseAll } from '../run/cleanup.js';
import { OwnershipError } from '../run/ownership.js';
import { attemptLabels, workspaceVolumeName } from '../volume/naming.js';
import { restoreWorkspace } from '../volume/snapshot.js';
import { createVolume, removeVolume, workspaceMount } from '../volume/workspace.js';

export const VERIFICATION_ARTIFACT = 'verification.json';

export interface CommandResult {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  status: RunStatus;
  durationMs: number;
}

export interface VerificationResult {
  status: 'pass' | 'fail' | 'timeout';
  commands: CommandResult[];
  /** Named so a caller can assert it is gone; it is removed before this returns. */
  workspaceVolume: string;
}

export interface VerificationOptions {
  attempt: string;
  /** The immutable implementation snapshot — the only acceptance candidate (§15). */
  snapshot: StoredArtifact;
  dependencySnapshot: Buffer;
  /** Fixed argument arrays from `task.yml`; never shell strings (§16). */
  commands: readonly (readonly string[])[];
  artifactDir: string;
  images: RuntimeImages;
  timeoutSeconds?: number;
  graceSeconds?: number;
  /** Injectable acquisition steps, so each stage of the rollback window is testable. */
  createDependencies?: (
    scope: string,
    snapshot: Buffer,
    images: RuntimeImages,
    owner: string,
  ) => Promise<string>;
  restore?: (volume: string, snapshot: StoredArtifact, images: RuntimeImages) => Promise<void>;
  removeVolume?: (name: string) => Promise<void>;
}

export const DEFAULT_VERIFICATION_TIMEOUT_SECONDS = 600;

/**
 * Run the declared verification commands over a disposable copy of the implementation
 * snapshot with fresh dependencies, offline and without credentials.
 *
 * Nothing the verifier writes can be accepted: it works on a copy, and the copy is destroyed
 * here (§15).
 */
export async function runVerification(
  options: VerificationOptions,
): Promise<VerificationResult> {
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_VERIFICATION_TIMEOUT_SECONDS;
  const graceSeconds = options.graceSeconds ?? 10;

  const acquireDependencies = options.createDependencies ?? acquireVerifierDependencies;
  const restore = options.restore ?? restoreWorkspace;
  const release = options.removeVolume ?? removeVolume;

  const workspaceVolume = workspaceVolumeName(`${options.attempt}-verify`);

  // Each resource is registered the moment it exists, so a failure part-way through
  // acquisition rolls back exactly what was acquired — and never names a volume that was
  // not. The previous shape created two volumes before entering any cleanup scope, so a
  // dependency-volume failure stranded the workspace volume.
  const rollback: (() => Promise<void>)[] = [];
  let outcome: { value: VerificationResult } | { error: unknown };

  try {
    await createVolume(workspaceVolume, attemptLabels(options.attempt, 'verify-workspace'));
    rollback.push(() => release(workspaceVolume));

    const dependencyVolume = await acquireDependencies(
      `${options.attempt}-verify`,
      options.dependencySnapshot,
      options.images,
      options.attempt,
    );
    rollback.push(() => release(dependencyVolume));

    await restore(workspaceVolume, options.snapshot, options.images);

    const commands: CommandResult[] = [];
    let status: VerificationResult['status'] = 'pass';

    for (const argv of options.commands) {
      const run = await runContainer(
        {
          image: options.images.verifier.reference,
          argv: [...argv],
          // DESIGN.md §6: no network at all, so verification cannot reach a model.
          network: 'none',
          mounts: [workspaceMount(workspaceVolume), dependencyMount(dependencyVolume)],
          labels: attemptLabels(options.attempt, 'verify'),
        },
        { timeoutSeconds, graceSeconds },
      );

      commands.push({
        argv: [...argv],
        exitCode: run.exitCode,
        stdout: run.stdout,
        stderr: run.stderr,
        status: run.status,
        durationMs: run.durationMs,
      });

      if (run.status === 'timeout') {
        status = 'timeout';
        break;
      }

      if (run.exitCode !== 0) {
        status = 'fail';
        break;
      }
    }

    outcome = { value: { status, commands, workspaceVolume } };
  } catch (error) {
    outcome = { error };
  }

  // Outside a `finally`, so a volume that could not be released is reported rather than
  // silently replacing whatever failure was already in flight.
  const errors = await releaseAll(rollback);

  if (errors.length > 0) {
    const cleanup = new CleanupError(errors);

    if ('error' in outcome) {
      throw new OwnershipError(`verifier workspace ${workspaceVolume}`, outcome.error, cleanup);
    }
    throw cleanup;
  }

  if ('error' in outcome) throw outcome.error;

  await mkdir(options.artifactDir, { recursive: true });
  await writeFile(
    join(options.artifactDir, VERIFICATION_ARTIFACT),
    `${JSON.stringify(outcome.value, null, 2)}\n`,
  );

  return outcome.value;
}

/** Adapts the dependency-volume signature to the acquisition step's argument order. */
function acquireVerifierDependencies(
  scope: string,
  snapshot: Buffer,
  images: RuntimeImages,
  owner: string,
): Promise<string> {
  return createDependencyVolume(scope, 'verifier', snapshot, images, owner);
}
