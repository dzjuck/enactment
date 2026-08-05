import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { pack } from 'tar-stream';

import type { ValidatedChangeSet } from '../diff/validate.js';
import type { RuntimeImages } from '../docker/images.js';
import { runContainer, type RunOptions, type RunResult } from '../docker/run.js';
import { CleanupError, releaseAll } from '../run/cleanup.js';
import { OwnershipError } from '../run/ownership.js';
import { attemptLabels, reviewVolumeName } from '../volume/naming.js';
import { createVolume, removeVolume } from '../volume/workspace.js';
import { REVIEW_ROOT, REVIEW_TIMEOUT_SECONDS } from './policy.js';
import {
  parseReviewDocument,
  type ReviewFinding,
  type ReviewScan,
} from './results.js';
import { compileReviewArgv, deriveReviewTargets, type ReviewTargets } from './targets.js';

export const REVIEW_SCAN_ARTIFACT = 'scan.json';
export const REVIEW_RESULT_ARTIFACT = 'review.json';
export const REVIEW_LOG_ARTIFACT = 'reviewer.log';

type RunReviewerContainer = (spec: Parameters<typeof runContainer>[0], options?: RunOptions) => Promise<RunResult>;

export interface ReviewExecutionResult {
  readonly reviewerImageId: string;
  readonly scannedPaths: {
    readonly before: readonly string[];
    readonly after: readonly string[];
  };
  readonly findings: readonly ReviewFinding[];
  readonly durationMs: number;
}

export interface ReviewOptions {
  readonly attempt: string;
  readonly changes: ValidatedChangeSet;
  readonly artifactDir: string;
  readonly images: RuntimeImages;
  readonly redact?: (text: string) => string;
  readonly timeoutSeconds?: number;
  readonly graceSeconds?: number;
  readonly run?: RunReviewerContainer;
  readonly createVolume?: (name: string, labels: Record<string, string>) => Promise<void>;
  readonly removeVolume?: (name: string) => Promise<void>;
}

export class ReviewRunError extends Error {
  readonly category = 'review_failed' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ReviewRunError';
  }
}

async function packTargets(targets: ReviewTargets): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));

  const done = new Promise<Buffer>((resolve, reject) => {
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
  });

  for (const side of ['before', 'after'] as const) {
    for (const target of targets[side]) {
      await new Promise<void>((resolve, reject) => {
        archive.entry(
          { name: `${side}/${target.path}`, type: 'file', mode: 0o644 },
          target.content,
          (error) => (error === undefined || error === null ? resolve() : reject(error)),
        );
      });
    }
  }

  archive.finalize();
  return done;
}

function checked(result: RunResult, operation: string): RunResult {
  if (result.status === 'timeout') {
    throw new ReviewRunError(`${operation} timed out`);
  }
  if (result.exitCode !== 0) {
    throw new ReviewRunError(`${operation} failed with exit code ${result.exitCode}`);
  }
  return result;
}

async function writeArtifacts(
  artifactDir: string,
  scan: ReviewScan,
  result: ReviewExecutionResult,
  log: string,
  redact: (text: string) => string,
): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  await Promise.all([
    writeFile(join(artifactDir, REVIEW_SCAN_ARTIFACT), redact(`${JSON.stringify(scan, null, 2)}\n`)),
    writeFile(
      join(artifactDir, REVIEW_RESULT_ARTIFACT),
      redact(`${JSON.stringify(result, null, 2)}\n`),
    ),
    writeFile(join(artifactDir, REVIEW_LOG_ARTIFACT), redact(log)),
  ]);
}

function executionResult(
  targets: ReviewTargets,
  images: RuntimeImages,
  findings: readonly ReviewFinding[],
  durationMs: number,
): ReviewExecutionResult {
  return {
    reviewerImageId: images.reviewer.id,
    scannedPaths: {
      before: targets.before.map((target) => target.path),
      after: targets.after.map((target) => target.path),
    },
    findings,
    durationMs,
  };
}

/** Run the fixed Semgrep contract over one disposable changed-files volume. */
export async function runReview(options: ReviewOptions): Promise<ReviewExecutionResult> {
  const targets = deriveReviewTargets(options.changes);
  const redact = options.redact ?? ((text: string) => text);

  if (targets.before.length === 0 && targets.after.length === 0) {
    const result = executionResult(targets, options.images, [], 0);
    await writeArtifacts(options.artifactDir, { before: [], after: [] }, result, '', redact);
    return result;
  }

  const run = options.run ?? runContainer;
  const acquire = options.createVolume ?? createVolume;
  const release = options.removeVolume ?? removeVolume;
  const volume = reviewVolumeName(options.attempt);
  const rollback: (() => Promise<void>)[] = [];
  let outcome: { scan: RunResult } | { error: unknown };

  try {
    await acquire(volume, attemptLabels(options.attempt, 'review'));
    rollback.push(() => release(volume));

    const tar = await packTargets(targets);
    checked(
      await run(
        {
          image: options.images.setup.id,
          argv: [
            'tar',
            '--extract',
            '--preserve-permissions',
            '--file',
            '-',
            '--directory',
            '/workspace',
          ],
          network: 'none',
          mounts: [{ type: 'volume', source: volume, target: '/workspace' }],
          labels: attemptLabels(options.attempt, 'review-seed'),
        },
        { input: tar },
      ),
      'review volume seed',
    );

    outcome = {
      scan: checked(
        await run(
          {
            image: options.images.reviewer.id,
            argv: compileReviewArgv(),
            network: 'none',
            mounts: [{ type: 'volume', source: volume, target: REVIEW_ROOT, readonly: true }],
            labels: attemptLabels(options.attempt, 'review'),
          },
          {
            timeoutSeconds: options.timeoutSeconds ?? REVIEW_TIMEOUT_SECONDS,
            ...(options.graceSeconds === undefined ? {} : { graceSeconds: options.graceSeconds }),
          },
        ),
        'review scan',
      ),
    };
  } catch (error) {
    outcome = { error };
  }

  const cleanupErrors = await releaseAll(rollback);
  if (cleanupErrors.length > 0) {
    const cleanup = new CleanupError(cleanupErrors);
    if ('error' in outcome) throw new OwnershipError(`review volume ${volume}`, outcome.error, cleanup);
    throw cleanup;
  }

  if ('error' in outcome) throw outcome.error;

  let parsed: ReturnType<typeof parseReviewDocument>;
  try {
    parsed = parseReviewDocument(outcome.scan.stdout, targets);
  } catch (error) {
    await mkdir(options.artifactDir, { recursive: true });
    await writeFile(join(options.artifactDir, REVIEW_LOG_ARTIFACT), redact(outcome.scan.stderr));
    throw error;
  }

  const result = executionResult(
    targets,
    options.images,
    parsed.result.findings,
    outcome.scan.durationMs,
  );
  await writeArtifacts(options.artifactDir, parsed.scan, result, outcome.scan.stderr, redact);
  return result;
}
