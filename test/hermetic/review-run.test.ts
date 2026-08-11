import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileEntry } from '../../src/diff/source-diff.js';
import type { ValidatedChangeSet } from '../../src/diff/validate.js';
import { IMAGE_ROLES } from '../../src/config/pins.js';
import type { ContainerSpec } from '../../src/docker/args.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import type { RunOptions, RunResult } from '../../src/docker/run.js';
import { CleanupError } from '../../src/run/cleanup.js';
import { REVIEW_ROOT } from '../../src/review/policy.js';
import {
  REVIEW_LOG_ARTIFACT,
  REVIEW_RESULT_ARTIFACT,
  REVIEW_SCAN_ARTIFACT,
  ReviewRunError,
  runReview,
} from '../../src/review/run.js';
import { compileReviewArgv } from '../../src/review/targets.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/review', import.meta.url));
const SECRET = 'review-secret-canary-9921';
const CRITICAL = `const { spawn } = require('child_process');
spawn('ls', ['-la'], { shell: true });
`;

const IMAGES = Object.fromEntries(
  IMAGE_ROLES.map((role, index) => [
    role,
    { role, id: `sha256:${String(index + 1).repeat(64)}` },
  ]),
) as RuntimeImages;

function file(path: string, content: string): FileEntry {
  const bytes = Buffer.from(content);
  return {
    path,
    type: 'file',
    mode: 0o644,
    hash: createHash('sha256').update(bytes).digest('hex'),
    content: bytes,
  };
}

function added(path: string, content: string): ValidatedChangeSet {
  const entry = file(path, content);
  return { changes: [{ kind: 'added', path, entry }] };
}

function completed(stdout = '', stderr = '', exitCode = 0): RunResult {
  return {
    exitCode,
    stdout,
    stderr,
    stdoutBytes: Buffer.from(stdout),
    durationMs: 7,
    status: 'completed',
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'enactment-review-run-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function criticalFixture(): Promise<string> {
  return await readFile(join(FIXTURES, 'critical.json'), 'utf8');
}

describe('offline review execution', () => {
  it('seeds once, scans once with the fixed isolated contract, releases, then writes safe artifacts', async () => {
    const calls: { spec: ContainerSpec; options: RunOptions | undefined }[] = [];
    let released = false;
    const artifactDir = join(dir, 'review');
    const run = vi.fn(async (spec: ContainerSpec, options?: RunOptions) => {
      calls.push({ spec, options });
      return calls.length === 1
        ? completed()
        : completed(await criticalFixture(), `diagnostic ${SECRET}`);
    });

    const result = await runReview({
      attempt: 'attempt-1',
      risk: 'standard',
      changes: added('src/run.js', CRITICAL),
      artifactDir,
      images: IMAGES,
      redact: (text) => text.replaceAll(SECRET, '[redacted]'),
      run,
      createVolume: () => Promise.resolve(),
      removeVolume: async () => {
        await expect(access(join(artifactDir, REVIEW_RESULT_ARTIFACT))).rejects.toThrow();
        released = true;
      },
    });

    expect(released).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(calls[0]?.spec).toMatchObject({
      image: IMAGES.setup.id,
      network: 'none',
      mounts: [{ type: 'volume', target: '/workspace' }],
    });
    expect(calls[0]?.options?.input).toBeInstanceOf(Buffer);
    expect(calls[1]?.spec).toMatchObject({
      image: IMAGES.reviewer.id,
      argv: compileReviewArgv(),
      network: 'none',
      mounts: [{ type: 'volume', target: REVIEW_ROOT, readonly: true }],
    });
    expect(calls[1]?.spec.mounts).toHaveLength(1);
    expect(calls[1]?.spec.env).toBeUndefined();
    expect(result.findings).toHaveLength(1);

    const scan = await readFile(join(artifactDir, REVIEW_SCAN_ARTIFACT), 'utf8');
    const review = await readFile(join(artifactDir, REVIEW_RESULT_ARTIFACT), 'utf8');
    const log = await readFile(join(artifactDir, REVIEW_LOG_ARTIFACT), 'utf8');
    expect(JSON.parse(scan)).toMatchObject({ before: [], after: [{ path: 'src/run.js' }] });
    expect(JSON.parse(review)).toMatchObject({
      reviewerImageId: IMAGES.reviewer.id,
      scannedPaths: { before: [], after: ['src/run.js'] },
      findings: [{ path: 'src/run.js', severity: 'critical' }],
      durationMs: 7,
    });
    expect(`${scan}${review}${log}`).not.toContain(CRITICAL.trim());
    expect(`${scan}${review}${log}`).not.toContain(SECRET);
    expect(log).toContain('[redacted]');
  });

  it('returns a clean review without creating a volume or starting a container for no targets', async () => {
    const deleted = file('src/deleted.js', 'old');
    const createVolume = vi.fn(() => Promise.resolve());
    const run = vi.fn(() => Promise.resolve(completed()));

    const result = await runReview({
      attempt: 'attempt-empty',
      risk: 'standard',
      changes: { changes: [{ kind: 'deleted', path: deleted.path, previous: deleted }] },
      artifactDir: join(dir, 'empty'),
      images: IMAGES,
      run,
      createVolume,
      removeVolume: vi.fn(() => Promise.resolve()),
    });

    expect(result.findings).toEqual([]);
    expect(createVolume).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['timeout', { ...completed(), status: 'timeout' as const, exitCode: -1 }],
    ['non-zero exit', completed('', 'scanner failed', 2)],
    ['malformed output', completed('{')],
    ['scanner error', undefined],
  ])('fails closed as review_failed on %s and releases the volume', async (_name, failure) => {
    const removed: string[] = [];
    const scanResult = failure ?? completed(await readFile(join(FIXTURES, 'scan-error.json'), 'utf8'));
    let calls = 0;

    const error = await runReview({
      attempt: `attempt-${_name}`,
      risk: 'standard',
      changes: added('src/run.js', CRITICAL),
      artifactDir: join(dir, String(_name)),
      images: IMAGES,
      createVolume: () => Promise.resolve(),
      removeVolume: async (name) => void removed.push(name),
      run: () => Promise.resolve(++calls === 1 ? completed() : scanResult),
    }).catch((cause: unknown) => cause);

    expect((error as { category?: string }).category).toBe('review_failed');
    expect(removed).toHaveLength(1);
  });

  it('raises a release failure and writes no artifact', async () => {
    let calls = 0;
    const artifactDir = join(dir, 'release-failure');

    const error = await runReview({
      attempt: 'attempt-release',
      risk: 'standard',
      changes: added('src/run.js', CRITICAL),
      artifactDir,
      images: IMAGES,
      createVolume: () => Promise.resolve(),
      removeVolume: () => Promise.reject(new Error('volume removal refused')),
      run: async () => completed(++calls === 1 ? '' : await criticalFixture()),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CleanupError);
    await expect(access(join(artifactDir, REVIEW_RESULT_ARTIFACT))).rejects.toThrow();
  });

  it('uses a typed review_failed error for scanner execution failures', () => {
    expect(new ReviewRunError('failed').category).toBe('review_failed');
  });

  it.each([
    ['standard', 'warning', 'pass'],
    ['high', 'warning', 'blocked'],
    ['standard', 'critical', 'blocked'],
    ['high', 'critical', 'blocked'],
  ] as const)('%s risk with a %s finding produces %s', async (risk, fixtureName, verdict) => {
    const source = fixtureName === 'critical' ? CRITICAL : `const crypto = require('crypto');
module.exports = () => crypto.pseudoRandomBytes(16);
`;
    let calls = 0;
    const result = await runReview({
      attempt: `attempt-${risk}-${fixtureName}`,
      risk,
      changes: added(fixtureName === 'critical' ? 'src/run.js' : 'src/random.js', source),
      artifactDir: join(dir, `${risk}-${fixtureName}`),
      images: IMAGES,
      createVolume: () => Promise.resolve(),
      removeVolume: () => Promise.resolve(),
      run: async () =>
        completed(
          ++calls === 1 ? '' : await readFile(join(FIXTURES, `${fixtureName}.json`), 'utf8'),
        ),
    });

    expect(result).toMatchObject({ risk, verdict });
  });
});
