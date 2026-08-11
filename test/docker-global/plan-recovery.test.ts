import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import type { RuntimeImage } from '../../src/docker/images.js';
import {
  buildManifest,
  loadManifest,
  validateManifest,
  writeManifest,
} from '../../src/plan/execution-manifest.js';
import { sweepHarness } from '../../src/run/cleanup.js';
import { runPlan } from '../../src/run/coordinator.js';
import { StateStore } from '../../src/state/store.js';
import { ATTEMPT_LABEL, ROLE_LABEL } from '../../src/volume/naming.js';
import { createM2Repo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

/**
 * The plan-level restart path, for real: a two-step plan is killed during its first step, and
 * the next run sweeps the orphaned resources, reuses the crashed attempt id, and carries the
 * plan through to completion.
 *
 * Both runs are stub-driven, so no provider tokens are spent; what is exercised is the
 * reconciliation, not the model.
 */

const NOTES = 'notes.txt';

const PLAN = [
  'version: 1',
  'id: recovery-plan',
  'steps:',
  ...['first-step', 'second-step'].flatMap((id) => [
    '  - type: task',
    '    complexity: low',
    '    risk: standard',
    `    id: ${id}`,
    `    observable_behavior: Record a note for ${id}.`,
    '    implementation_paths:',
    `      - ${NOTES}`,
    '    verification:',
    '      commands:',
    '        - ["node", "--version"]',
    '    timeouts:',
    '      connectivity_smoke_seconds: 20',
    '      agent_seconds: 300',
    '      termination_grace_seconds: 2',
  ]),
  'final_verification:',
  '  commands:',
  `    - ["node", "-e", "const c = require('node:fs').readFileSync('${NOTES}', 'utf8'); if (c !== 'step\\\\nstep\\\\n') { throw new Error('unexpected: ' + JSON.stringify(c)); }"]`,
  '',
].join('\n');

let repo: TargetRepo;
let root: string;
let stub: RuntimeImage;
let runnerScript: string;

beforeAll(async () => {
  stub = await stubAgentImage();
  repo = await createM2Repo();
  root = await mkdtemp(join(tmpdir(), 'enactment-plan-recovery-'));

  const source = join(root, 'codex-source');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, AUTH_FILE),
    JSON.stringify({ tokens: { access_token: 'sk-plan-recovery-canary' } }),
  );

  await writeFile(join(root, 'plan.yml'), PLAN);

  // The coordinator has no stub seam of its own, so the run that gets killed drives it
  // directly in a child process.
  runnerScript = join(root, 'runner.mjs');
  await writeFile(
    runnerScript,
    [
      `import { loadManifest, validateManifest } from ${JSON.stringify(join(process.cwd(), 'dist/plan/execution-manifest.js'))};`,
      `import { runPlan } from ${JSON.stringify(join(process.cwd(), 'dist/run/coordinator.js'))};`,
      `import { StateStore } from ${JSON.stringify(join(process.cwd(), 'dist/state/store.js'))};`,
      'const input = JSON.parse(process.env.ENACTMENT_TEST_RUN);',
      'const approved = await validateManifest(await loadManifest(input.manifestPath), {',
      '  repoPath: input.repoPath,',
      '});',
      'const store = StateStore.open(input.databasePath);',
      'await runPlan({',
      '  approved,',
      '  store,',
      '  artifactsRoot: input.artifactsRoot,',
      '  sourceCodexHome: input.sourceCodexHome,',
      '  storeDirectory: input.storeDirectory,',
      '  dependencyCacheDirectory: input.dependencyCacheDirectory,',
      '  injection: input.injection,',
      '});',
      '',
    ].join('\n'),
  );
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

async function labelled(kind: 'container' | 'volume' | 'network'): Promise<string[]> {
  const filter = `label=${ATTEMPT_LABEL}`;
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', filter]
      : [kind, 'ls', '-q', '--filter', filter];

  const { stdout } = await execa('docker', args);
  return stdout.split('\n').filter((line) => line !== '');
}

/**
 * Containers of one role belonging to one attempt, running right now.
 *
 * Both filters matter. Without the attempt id this matches another test file's resources;
 * without the role it also matches this attempt's setup container, which exits on its own —
 * and a kill timed against a container that has already gone leaves nothing to recover.
 */
async function runningAgentContainers(attempt: string): Promise<string[]> {
  const { stdout } = await execa('docker', [
    'ps',
    '-q',
    '--filter',
    `label=${ATTEMPT_LABEL}=${attempt}`,
    '--filter',
    `label=${ROLE_LABEL}=agent`,
  ]);
  return stdout.split('\n').filter((line) => line !== '');
}

/** The attempt id the child process recorded for the plan's first step. */
async function firstAttemptId(databasePath: string, repoPath: string): Promise<string> {
  for (let poll = 0; poll < 1200; poll += 1) {
    if (existsSync(databasePath)) {
      const store = StateStore.open(databasePath);
      try {
        const plan = store.activePlanForRepo(repoPath);
        const step = plan === undefined ? undefined : store.steps(plan.row)[0];
        const attempt = step === undefined ? undefined : store.attempts(step.row)[0];
        if (attempt !== undefined) return attempt.attemptId;
      } finally {
        store.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('the killed run never recorded an attempt for its first step');
}

const stubEnv = (mode: string): Record<string, string> => ({
  STUB_MODE: mode,
  STUB_EVENTS: cannedEvents(),
  STUB_APPEND_PATH: NOTES,
  STUB_APPEND_CONTENT: 'step\n',
});

describe('a SIGKILLed plan run', () => {
  it('is swept, reconciled and carried to completion by the next run', async () => {
    const artifactsRoot = join(root, 'artifacts');
    const databasePath = join(root, 'state', 'state.db');
    const planFile = join(root, 'plan.yml');
    const manifestPath = join(root, 'execution-manifest.yml');

    await writeManifest(
      manifestPath,
      (await buildManifest({ planFile, manifestPath, repoPath: repo.dir })).manifest,
    );

    const killed = execa('node', [runnerScript], {
      reject: false,
      env: {
        ENACTMENT_TEST_RUN: JSON.stringify({
          manifestPath,
          repoPath: repo.dir,
          artifactsRoot,
          databasePath,
          sourceCodexHome: join(root, 'codex-source'),
          storeDirectory: join(root, 'store'),
          dependencyCacheDirectory: join(root, 'deps'),
          // Hangs, so the agent container is alive when the process is killed.
          injection: { codex: stub, agentEnv: stubEnv('hang') },
        }),
      },
    });

    try {
      const crashedId = await firstAttemptId(databasePath, repo.dir);

      // Kill only once this attempt's own agent container is up. It hangs, so it is still
      // there afterwards — which is the state the next run has to recover from.
      let running: string[] = [];
      for (let poll = 0; poll < 1800; poll += 1) {
        running = await runningAgentContainers(crashedId);
        if (running.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(running).not.toEqual([]);

      killed.kill('SIGKILL');
      await killed;

      // No teardown ran: the attempt id that owned this container died with the process.
      expect(await runningAgentContainers(crashedId)).toEqual(running);

      const crashed = StateStore.open(databasePath);
      const crashedPlan = crashed.activePlanForRepo(repo.dir);
      const crashedStep = crashed.steps(crashedPlan?.row ?? 0)[0];
      const crashedAttempt = crashed.attempts(crashedStep?.row ?? 0)[0];
      expect(crashedAttempt?.attemptId).toBe(crashedId);
      expect(crashedAttempt?.state).toBe('running');
      crashed.close();

      // What the production CLI does at startup, before it selects any work.
      await sweepHarness();
      expect(await labelled('container')).toEqual([]);
      expect(await labelled('volume')).toEqual([]);
      expect(await labelled('network')).toEqual([]);

      const store = StateStore.open(databasePath);
      const approved = await validateManifest(await loadManifest(manifestPath), {
        repoPath: repo.dir,
      });

      const report = await runPlan({
        approved,
        store,
        artifactsRoot,
        manifestPath,
        sourceCodexHome: join(root, 'codex-source'),
        storeDirectory: join(root, 'store'),
        dependencyCacheDirectory: join(root, 'deps'),
        injection: { codex: stub, agentEnv: stubEnv('write') },
      });

      expect(report.failure).toBeUndefined();
      expect(report.state).toBe('completed');
      expect(report.finalVerification?.status).toBe('pass');

      // The crashed attempt kept its id and reran; its evidence sits beside the recovery run.
      expect(report.steps[0]?.attempts.at(-1)?.id).toBe(crashedId);
      const runs = await readdir(
        join(artifactsRoot, 'recovery-plan', 'steps', 'first-step', crashedId),
      );
      expect(runs.sort()).toEqual(['run-1', 'run-2']);

      // One linear branch, both steps, and no duplicate commit for the reran step.
      const branch = 'enactment/recovery-plan';
      expect(await git(repo.dir, ['rev-list', '--count', branch])).toBe('3');
      expect(await git(repo.dir, ['show', `${report.head ?? ''}:${NOTES}`])).toBe('step\nstep');

      const stored = JSON.parse(
        await readFile(
          join(artifactsRoot, 'recovery-plan', 'reports', 'invocation-1.json'),
          'utf8',
        ),
      ) as { state: string };
      expect(stored.state).toBe('completed');

      store.close();
    } finally {
      await sweepHarness().catch(() => undefined);
    }
  }, 900_000);
});
