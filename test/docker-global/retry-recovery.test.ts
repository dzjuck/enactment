import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa, type ResultPromise } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeImages } from '../../src/docker/images.js';
import {
  buildManifest,
  loadManifest,
  validateManifest,
  writeManifest,
} from '../../src/plan/execution-manifest.js';
import { runPlan } from '../../src/run/coordinator.js';
import type { StepExecutionOptions } from '../../src/run/orchestrator.js';
import { StateStore } from '../../src/state/store.js';
import { createM2Repo, removeRepo } from '../helpers/repo.js';

const IMAGES: RuntimeImages = {
  codex: { role: 'codex', id: `sha256:${'a'.repeat(64)}` },
  claude: { role: 'claude', id: `sha256:${'b'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'c'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'d'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'e'.repeat(64)}` },
};

const roots: string[] = [];
const repos: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(repos.splice(0).map((repo) => removeRepo(repo)));
});

async function fixture(category = 'agent_failed') {
  const repo = await createM2Repo();
  repos.push(repo.dir);
  const root = await mkdtemp(join(tmpdir(), 'harness-retry-recovery-'));
  roots.push(root);
  const planFile = join(root, 'plan.yml');
  await writeFile(
    planFile,
    [
      'version: 1',
      `id: retry-recovery-${category.replaceAll('_', '-')}`,
      'steps:',
      '  - type: task',
      '    complexity: low',
      '    id: first-step',
      '    observable_behavior: Write one note.',
      '    implementation_paths:',
      '      - note.txt',
      '    verification:',
      '      commands:',
      '        - ["node", "--version"]',
      'final_verification:',
      '  commands:',
      '    - ["node", "--version"]',
      '',
    ].join('\n'),
  );
  const manifestPath = join(root, 'execution-manifest.yml');
  await writeManifest(
    manifestPath,
    await buildManifest({
      planFile,
      manifestPath,
      repoPath: repo.dir,
      resolveImages: () => Promise.resolve(IMAGES),
    }),
  );
  const approved = await validateManifest(await loadManifest(manifestPath), {
    repoPath: repo.dir,
    resolveImages: () => Promise.resolve(IMAGES),
  });
  return {
    repo,
    root,
    manifestPath,
    approved,
    databasePath: join(root, 'state.db'),
    artifactsRoot: join(root, 'artifacts'),
  };
}

async function runner(root: string): Promise<string> {
  const path = join(root, 'runner.mjs');
  await writeFile(
    path,
    [
      `import { mkdir, writeFile } from 'node:fs/promises';`,
      `import { join } from 'node:path';`,
      `import { loadManifest, validateManifest } from ${JSON.stringify(join(process.cwd(), 'dist/plan/execution-manifest.js'))};`,
      `import { runPlan } from ${JSON.stringify(join(process.cwd(), 'dist/run/coordinator.js'))};`,
      `import { StateStore } from ${JSON.stringify(join(process.cwd(), 'dist/state/store.js'))};`,
      'const input = JSON.parse(process.env.HARNESS_TEST_RUN);',
      'const approved = await validateManifest(await loadManifest(input.manifestPath), {',
      '  repoPath: input.repoPath,',
      '  resolveImages: () => Promise.resolve(input.images),',
      '});',
      'const store = StateStore.open(input.databasePath);',
      'const dependencies = {',
      '  execute: async (options) => {',
      '    if (options.profile.id === "claude-deep" && input.stronger === "hang") {',
      '      await new Promise(() => {});',
      '    }',
      '    return { status: "failed", attempt: options.attempt, category: input.category, message: "planned failure" };',
      '  },',
      '  diagnose: async (options) => {',
      '    const dir = join(options.attempt.artifactPath, "diagnosis");',
      '    await mkdir(dir, { recursive: true });',
      '    const result = { status: "completed", text: "retry once" };',
      '    await writeFile(join(dir, "diagnosis.json"), JSON.stringify(result));',
      '    return result;',
      '  },',
      '  verifyFinal: () => { throw new Error("should not verify"); },',
      '};',
      'if (input.hangReport) dependencies.writeReport = async () => new Promise(() => {});',
      'await runPlan({ approved, store, artifactsRoot: input.artifactsRoot }, dependencies);',
      '',
    ].join('\n'),
  );
  return path;
}

function startChild(
  script: string,
  input: Record<string, unknown>,
): ResultPromise {
  return execa('node', [script], {
    reject: false,
    env: { HARNESS_TEST_RUN: JSON.stringify(input) },
  });
}

async function waitForAttempts(
  databasePath: string,
  repoPath: string,
  count: number,
  state?: string,
) {
  for (let poll = 0; poll < 1200; poll += 1) {
    if (existsSync(databasePath)) {
      const store = StateStore.open(databasePath);
      try {
        const plan = store.activePlanForRepo(repoPath);
        const step = plan === undefined ? undefined : store.steps(plan.row)[0];
        const attempts = step === undefined ? [] : store.attempts(step.row);
        if (attempts.length === count && (state === undefined || attempts.at(-1)?.state === state)) {
          return { plan, attempts };
        }
      } finally {
        store.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for durable attempts');
}

describe('retry crash boundaries', () => {
  it('keeps the normal failure and reuses an interrupted stronger attempt', async () => {
    const h = await fixture();
    const script = await runner(h.root);
    const child = startChild(script, {
      manifestPath: h.manifestPath,
      repoPath: h.repo.dir,
      databasePath: h.databasePath,
      artifactsRoot: h.artifactsRoot,
      images: IMAGES,
      category: 'agent_failed',
      stronger: 'hang',
    });

    const before = await waitForAttempts(h.databasePath, h.repo.dir, 2, 'running');
    child.kill('SIGKILL');
    await child;
    expect(before.attempts[0]?.state).toBe('failed');
    expect(before.attempts[1]?.kind).toBe('stronger');

    const store = StateStore.open(h.databasePath);
    const seen: StepExecutionOptions[] = [];
    const report = await runPlan(
      { approved: h.approved, store, artifactsRoot: h.artifactsRoot },
      {
        execute: (options) => {
          seen.push(options);
          return Promise.resolve({
            status: 'failed',
            attempt: options.attempt,
            category: 'provider_error',
            message: 'stop after recovery',
          });
        },
        diagnose: () => Promise.reject(new Error('diagnosis must not repeat')),
        verifyFinal: () => Promise.reject(new Error('should not verify')),
      },
    );
    store.close();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.attempt).toBe(before.attempts[1]?.attemptId);
    expect(seen[0]?.profile.id).toBe('claude-deep');
    expect(report.steps[0]?.attempts).toHaveLength(2);
  }, 120_000);

  it.each([
    { category: 'agent_failed', attempts: 2 },
    { category: 'provider_error', attempts: 1 },
  ])('reports a killed terminal $category cycle without opening another', async ({ category, attempts }) => {
    const h = await fixture(category);
    const script = await runner(h.root);
    const child = startChild(script, {
      manifestPath: h.manifestPath,
      repoPath: h.repo.dir,
      databasePath: h.databasePath,
      artifactsRoot: h.artifactsRoot,
      images: IMAGES,
      category,
      hangReport: true,
    });

    const before = await waitForAttempts(h.databasePath, h.repo.dir, attempts, 'failed');
    expect(before.plan?.state).toBe('failed');
    child.kill('SIGKILL');
    await child;

    const store = StateStore.open(h.databasePath);
    let executed = false;
    const report = await runPlan(
      { approved: h.approved, store, artifactsRoot: h.artifactsRoot },
      {
        execute: () => {
          executed = true;
          return Promise.reject(new Error('must report the durable cycle'));
        },
        diagnose: () => Promise.reject(new Error('must not diagnose again')),
        verifyFinal: () => Promise.reject(new Error('should not verify')),
      },
    );
    const plan = store.activePlanForRepo(h.repo.dir);
    const step = store.steps(plan?.row ?? 0)[0];
    const after = store.attempts(step?.row ?? 0);
    store.close();

    expect(executed).toBe(false);
    expect(report.state).toBe('failed');
    expect(after).toHaveLength(attempts);
  }, 120_000);
});
