import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FileEntry } from '../../src/diff/source-diff.js';
import type { ValidatedChangeSet } from '../../src/diff/validate.js';
import type { ContainerSpec } from '../../src/docker/args.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { runContainer, type RunOptions } from '../../src/docker/run.js';
import { REVIEW_ROOT } from '../../src/review/policy.js';
import {
  REVIEW_LOG_ARTIFACT,
  REVIEW_RESULT_ARTIFACT,
  REVIEW_SCAN_ARTIFACT,
  runReview,
} from '../../src/review/run.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { runtimeImages } from '../helpers/images.js';

const SECRET = 'review-source-secret-canary-1842';
const WARNING = `const crypto = require('crypto');
module.exports = () => crypto.pseudoRandomBytes(16);
`;
const CRITICAL = `const { spawn } = require('child_process');
spawn('${SECRET}', [], { shell: true });
`;

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

let root: string;
let images: RuntimeImages;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-review-docker-'));
  images = await runtimeImages();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('reviewer phase', () => {
  it('runs the real reviewer offline over one read-only changed-files volume and subtracts baseline findings', async () => {
    const path = 'src/run.js';
    const previous = file(path, WARNING);
    const entry = file(path, `${WARNING}${CRITICAL}`);
    const changes: ValidatedChangeSet = {
      changes: [{ kind: 'modified', path, previous, entry }],
    };
    const specs: ContainerSpec[] = [];
    const artifactDir = join(root, newAttemptId());

    const result = await runReview({
      attempt: newAttemptId(),
      changes,
      artifactDir,
      images,
      redact: (text) => text.replaceAll(SECRET, '[redacted]'),
      run: (spec: ContainerSpec, options?: RunOptions) => {
        specs.push(spec);
        return runContainer(spec, options);
      },
      timeoutSeconds: 120,
      graceSeconds: 2,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ severity: 'critical', path });

    const reviewer = specs.find((spec) => spec.image === images.reviewer.id);
    expect(reviewer).toMatchObject({
      network: 'none',
      mounts: [{ type: 'volume', target: REVIEW_ROOT, readonly: true }],
    });
    expect(reviewer?.mounts).toHaveLength(1);
    expect(reviewer?.env).toBeUndefined();

    const artifacts = await Promise.all(
      [REVIEW_SCAN_ARTIFACT, REVIEW_RESULT_ARTIFACT, REVIEW_LOG_ARTIFACT].map((name) =>
        readFile(join(artifactDir, name), 'utf8'),
      ),
    );
    expect(artifacts.join('\n')).not.toContain(SECRET);
    expect(JSON.parse(artifacts[0] ?? '{}')).toMatchObject({
      before: [{ severity: 'warning', path }],
      after: [{ severity: 'critical', path }, { severity: 'warning', path }],
    });
  }, 300_000);
});
