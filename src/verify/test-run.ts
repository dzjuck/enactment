import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Mount } from '../docker/args.js';
import type { RuntimeImages } from '../docker/images.js';
import { runContainer, type RunStatus } from '../docker/run.js';
import { parseVitestJson } from './parse-vitest.js';
import type { TestRunResults } from './results.js';

export const TEST_RESULTS_ARTIFACT = 'vitest-results.json';
export const TEST_RESULTS_PATH = '.harness/results.json';

export interface TestCommandResult {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  status: RunStatus;
  durationMs: number;
}

export interface StructuredTestRun {
  command: TestCommandResult;
  results?: TestRunResults;
}

export interface StructuredTestRunOptions {
  testCommand: readonly string[];
  mounts: Mount[];
  artifactDir: string;
  images: RuntimeImages;
  timeoutSeconds: number;
  graceSeconds: number;
  labels: Record<string, string>;
  redact?: (text: string) => string;
}

export class TestRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestRunError';
  }
}

export async function runStructuredTests(
  options: StructuredTestRunOptions,
): Promise<StructuredTestRun> {
  const prepare = await runContainer({
    image: options.images.verifier.id,
    argv: ['mkdir', '-p', '.harness'],
    network: 'none',
    mounts: options.mounts,
    labels: options.labels,
  });

  if (prepare.exitCode !== 0) {
    throw new TestRunError(`could not prepare test results directory: ${prepare.stderr}`);
  }

  const argv = [
    ...options.testCommand,
    '--reporter=json',
    `--outputFile=${TEST_RESULTS_PATH}`,
  ];
  const run = await runContainer(
    {
      image: options.images.verifier.id,
      argv,
      network: 'none',
      mounts: options.mounts,
      labels: options.labels,
    },
    { timeoutSeconds: options.timeoutSeconds, graceSeconds: options.graceSeconds },
  );

  const command: TestCommandResult = {
    argv,
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    status: run.status,
    durationMs: run.durationMs,
  };

  if (run.status === 'timeout') return { command };

  const read = await runContainer({
    image: options.images.verifier.id,
    argv: ['cat', `/workspace/${TEST_RESULTS_PATH}`],
    network: 'none',
    mounts: options.mounts,
    labels: options.labels,
  });

  if (read.exitCode !== 0) {
    throw new TestRunError(`runner produced no results at ${TEST_RESULTS_PATH}`);
  }

  const redact = options.redact ?? ((text: string) => text);
  await mkdir(options.artifactDir, { recursive: true });
  await writeFile(join(options.artifactDir, TEST_RESULTS_ARTIFACT), redact(read.stdout));

  return {
    command,
    results: parseVitestJson(read.stdout, {
      artifactPath: TEST_RESULTS_ARTIFACT,
      exitCode: run.exitCode,
    }),
  };
}
