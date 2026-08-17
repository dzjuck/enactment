import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { RuntimeImages } from '../../src/docker/images.js';
import { loadManifest } from '../../src/plan/execution-manifest.js';
import type { PlanReport } from '../../src/run/coordinator.js';
import { git } from '../helpers/repo.js';
import { runtimeImages } from '../helpers/images.js';

interface DemoResult {
  exitCode: number;
  report: PlanReport;
  root: string;
  repoPath: string;
  stateDirectory: string;
  artifactDir: string;
  manifestPath: string;
  baseCommit: string;
  demoImageId: string;
  productionImages: RuntimeImages;
}

let root: string | undefined;

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe('published replay demo', () => {
  it('runs the frozen plan through production with the baked agent image', async () => {
    const { runDemo } = (await import('../../demo/run.mjs')) as {
      runDemo: (options: { write: (text: string) => void }) => Promise<DemoResult>;
    };
    let output = '';

    const result = await runDemo({
      write: (text) => {
        output += text;
      },
    });
    root = result.root;

    expect(result.exitCode).toBe(0);
    expect(result.report.state).toBe('completed');
    expect(result.report.steps).toHaveLength(2);
    expect(result.report.steps.map((step) => step.status)).toEqual(['completed', 'completed']);
    expect(result.report.finalVerification?.status).toBe('pass');

    const branch = 'enactment/task-summary';
    expect(await git(result.repoPath, ['rev-list', '--count', `${result.baseCommit}..${branch}`])).toBe(
      '2',
    );
    expect(await git(result.repoPath, ['rev-parse', 'HEAD'])).toBe(result.baseCommit);
    expect(await git(result.repoPath, ['status', '--porcelain'])).toBe('');

    const loaded = await loadManifest(result.manifestPath);
    expect(loaded.manifest.runtime.codex_image_id).toBe(result.demoImageId);
    expect(loaded.manifest.runtime.claude_image_id).toBe(result.demoImageId);
    for (const role of ['verifier', 'reviewer', 'setup', 'proxy'] as const) {
      expect(loaded.manifest.runtime[`${role}_image_id`]).toBe(result.productionImages[role].id);
    }

    expect(result.report.steps.flatMap((step) => step.attempts)).not.toContainEqual(
      expect.objectContaining({ kind: 'stronger' }),
    );
    expect(output.indexOf('summarize-tasks')).toBeGreaterThanOrEqual(0);
    expect(output.indexOf('summary-endpoint')).toBeGreaterThan(output.indexOf('summarize-tasks'));

    await expect(access(result.repoPath)).resolves.toBeUndefined();
    await expect(access(join(result.stateDirectory, 'state.db'))).resolves.toBeUndefined();
    await expect(access(join(result.artifactDir, 'task-summary'))).resolves.toBeUndefined();

    expect(result.productionImages).toEqual(await runtimeImages());
  }, 900_000);
});
