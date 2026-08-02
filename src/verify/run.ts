import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StoredArtifact } from '../artifacts/store.js';
import { createDependencyVolume, dependencyMount } from '../deps/volume.js';
import type { RuntimeImages } from '../docker/images.js';
import { runContainer, type RunStatus } from '../docker/run.js';
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

  const workspaceVolume = workspaceVolumeName(`${options.attempt}-verify`);
  await createVolume(workspaceVolume, attemptLabels(options.attempt, 'verify-workspace'));

  const dependencyVolume = await createDependencyVolume(
    `${options.attempt}-verify`,
    'verifier',
    options.dependencySnapshot,
    options.images,
    options.attempt,
  );

  const commands: CommandResult[] = [];
  let status: VerificationResult['status'] = 'pass';

  try {
    await restoreWorkspace(workspaceVolume, options.snapshot, options.images);

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
  } finally {
    await removeVolume(workspaceVolume);
    await removeVolume(dependencyVolume);
  }

  const result: VerificationResult = { status, commands, workspaceVolume };

  await mkdir(options.artifactDir, { recursive: true });
  await writeFile(
    join(options.artifactDir, VERIFICATION_ARTIFACT),
    `${JSON.stringify(result, null, 2)}\n`,
  );

  return result;
}
