import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeImages } from '../../src/docker/images.js';
import type { CoordinatorOptions, PlanReport } from '../../src/run/coordinator.js';
import { parseCommand } from '../../src/run/options.js';
import { execute, type CommandResult } from '../../src/run/production.js';
import { createM2Repo, removeRepo, type TargetRepo } from '../helpers/repo.js';

const IMAGES: RuntimeImages = {
  codex: { role: 'codex', id: `sha256:${'a'.repeat(64)}` },
  claude: { role: 'claude', id: `sha256:${'e'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'b'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'c'.repeat(64)}` },
  reviewer: { role: 'reviewer', id: `sha256:${'9'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'d'.repeat(64)}` },
};

const PLAN = [
  'version: 1',
  'id: demo-plan',
  'steps:',
  '  - type: task',
  '    complexity: low',
  '    risk: standard',
  '    id: only-step',
  '    observable_behavior: Do the thing.',
  '    implementation_paths:',
  '      - only-step.txt',
  '    verification:',
  '      commands:',
  '        - ["node", "--version"]',
  'final_verification:',
  '  commands:',
  '    - ["node", "--version"]',
  '',
].join('\n');

const dirs: string[] = [];
const repos: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(repos.splice(0).map((dir) => removeRepo(dir)));
});

interface Workspace {
  repo: TargetRepo;
  planFile: string;
  manifestPath: string;
  artifactDir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}

async function workspace(): Promise<Workspace> {
  const repo = await createM2Repo();
  repos.push(repo.dir);
  const dir = await mkdtemp(join(tmpdir(), 'enactment-run-progress-'));
  dirs.push(dir);
  const planFile = join(dir, 'plan.yml');
  await writeFile(planFile, PLAN);

  const stateDir = join(dir, 'state');
  return {
    repo,
    planFile,
    manifestPath: join(dir, 'execution-manifest.yml'),
    artifactDir: join(dir, 'artifacts'),
    stateDir,
    env: { ENACTMENT_STATE_DIR: stateDir },
  };
}

function prepare(space: Workspace, progress?: (text: string) => void): Promise<CommandResult> {
  return execute(
    parseCommand(
      [
        'prepare',
        space.planFile,
        '--repo',
        space.repo.dir,
        '--output',
        space.manifestPath,
      ],
      space.env,
    ),
    { resolveImages: () => Promise.resolve(IMAGES), progress },
  );
}

function runCommand(space: Workspace) {
  return parseCommand(
    ['run', space.manifestPath, '--repo', space.repo.dir, '--artifacts', space.artifactDir],
    space.env,
  );
}

function completed(options: CoordinatorOptions): PlanReport {
  return {
    plan: options.approved.plan.id,
    state: 'completed',
    branch: `enactment/${options.approved.plan.id}`,
    baseCommit: options.approved.baseCommit,
    head: 'c'.repeat(40),
    steps: [{ id: 'only-step', status: 'completed', attempts: [], commit: 'c'.repeat(40) }],
  };
}

describe('run progress wiring', () => {
  it('renders coordinator events separately and returns the unchanged JSON report', async () => {
    const space = await workspace();
    await prepare(space);
    let output = '';

    const result = await execute(runCommand(space), {
      sweep: () => Promise.resolve(),
      resolveImages: () => Promise.resolve(IMAGES),
      progress: (text) => {
        output += text;
      },
      coordinate: (options) => {
        const report = completed(options);
        options.onProgress?.({
          kind: 'plan',
          planId: options.approved.plan.id,
          planFile: options.approved.planFile,
          steps: 1,
          repoPath: options.approved.repoPath,
          baseBranch: options.approved.baseBranch,
          baseCommit: options.approved.baseCommit,
          branch: report.branch,
          artifactsRoot: join(options.artifactsRoot, options.approved.plan.id),
        });
        options.onProgress?.({
          kind: 'step',
          index: 1,
          total: 1,
          stepId: 'only-step',
          stepType: 'task',
          attempt: 'normal',
          provider: 'codex',
          model: 'gpt-5.6-luna',
          effort: 'medium',
        });
        options.onProgress?.({ kind: 'phase', name: 'implementation' });
        options.onProgress?.({ kind: 'stepDone', status: 'committed', commit: 'c'.repeat(40) });
        options.onProgress?.({ kind: 'phase', name: 'final' });
        return Promise.resolve(report);
      },
    });

    expect(output).toContain('      preparing\n');
    expect(output).toContain(`file     ${space.planFile}\n`);
    expect(output).toContain('[1/1] only-step  task  codex gpt-5.6-luna/medium\n');
    expect(output).toContain('completed  1 steps  1 commits');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(JSON.stringify(result.report))).toEqual(result.report);
    expect(result.report).toEqual(
      expect.objectContaining({ plan: 'demo-plan', state: 'completed', head: 'c'.repeat(40) }),
    );
  });

  it('writes preparing before the sweep and keeps it visible when validation fails', async () => {
    const space = await workspace();
    await prepare(space);
    await writeFile(space.planFile, `${PLAN}\n`);
    const order: string[] = [];
    let output = '';

    const result = await execute(runCommand(space), {
      progress: (text) => {
        output += text;
        if (text.includes('preparing')) order.push('preparing');
      },
      sweep: () => {
        order.push('sweep');
        return Promise.resolve();
      },
      resolveImages: () => Promise.resolve(IMAGES),
      coordinate: () => Promise.reject(new Error('must not coordinate')),
    });

    expect(order).toEqual(['preparing', 'sweep']);
    expect(output).toMatch(/^ {6}preparing\n/);
    expect(output).toContain('failed     run did not return a report\n');
    expect(result).toMatchObject({ exitCode: 1, report: { error: 'plan_changed' } });
  });

  it('finishes progress when coordination throws and returns the failure report', async () => {
    const space = await workspace();
    await prepare(space);
    let output = '';

    const result = await execute(runCommand(space), {
      progress: (text) => {
        output += text;
      },
      sweep: () => Promise.resolve(),
      resolveImages: () => Promise.resolve(IMAGES),
      coordinate: () => Promise.reject(new Error('coordinate exploded')),
    });

    expect(output).toMatch(/^ {6}preparing\n/);
    expect(output).toContain('failed     run did not return a report\n');
    expect(result).toEqual({
      report: { error: 'failed', message: 'coordinate exploded' },
      exitCode: 1,
    });
  });

  it('writes no progress for prepare, cancel, or docs', async () => {
    const space = await workspace();
    const chunks: string[] = [];
    const progress = (text: string): void => {
      chunks.push(text);
    };

    expect((await prepare(space, progress)).exitCode).toBe(0);
    expect(
      (
        await execute(parseCommand(['docs', space.planFile], space.env), {
          progress,
        })
      ).exitCode,
    ).toBe(0);

    await mkdir(space.stateDir, { recursive: true });
    const cancelled = await execute(
      parseCommand(['cancel', space.manifestPath, '--repo', space.repo.dir], space.env),
      { progress },
    );

    expect(cancelled.exitCode).toBe(1);
    expect(chunks).toEqual([]);
  });
});
