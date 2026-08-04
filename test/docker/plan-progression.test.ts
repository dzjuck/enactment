import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import { resolveRuntimeImages, type RuntimeImage } from '../../src/docker/images.js';
import {
  buildManifest,
  loadManifest,
  validateManifest,
  writeManifest,
} from '../../src/plan/execution-manifest.js';
import { runPlan, type PlanReport } from '../../src/run/coordinator.js';
import { StateStore } from '../../src/state/store.js';
import { createM2Repo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

const LABEL = 'ai-harness.attempt';
const NOTES = 'notes.txt';

/**
 * Two steps that both append to one file. The stub's environment is fixed for the whole plan,
 * so a second `step\n` line can only come from a workspace that already held the first — which
 * is exactly "step 2 observed step 1".
 */
const PLAN = [
  'version: 1',
  'id: two-step-plan',
  'steps:',
  '  - type: task',
  '    complexity: low',
  '    id: first-step',
  '    observable_behavior: Record the first note.',
  '    implementation_paths:',
  `      - ${NOTES}`,
  '    verification:',
  '      commands:',
  '        - ["node", "--version"]',
  '    timeouts:',
  '      connectivity_smoke_seconds: 20',
  '      agent_seconds: 30',
  '      termination_grace_seconds: 2',
  '  - type: task',
  '    complexity: low',
  '    id: second-step',
  '    observable_behavior: Record the second note beneath the first.',
  '    implementation_paths:',
  `      - ${NOTES}`,
  '    verification:',
  '      commands:',
  '        - ["node", "--version"]',
  '    timeouts:',
  '      connectivity_smoke_seconds: 20',
  '      agent_seconds: 30',
  '      termination_grace_seconds: 2',
  'final_verification:',
  '  commands:',
  `    - ["node", "-e", "const c = require('node:fs').readFileSync('${NOTES}', 'utf8'); if (c !== 'step\\\\nstep\\\\n') { throw new Error('unexpected notes: ' + JSON.stringify(c)); }"]`,
  '',
].join('\n');

let repo: TargetRepo;
let root: string;
let stub: RuntimeImage;
const dirs: string[] = [];
const stores: StateStore[] = [];

beforeAll(async () => {
  stub = await stubAgentImage();
  repo = await createM2Repo();
  root = await mkdtemp(join(tmpdir(), 'harness-plan-'));

  await writeFile(
    join(root, AUTH_FILE),
    JSON.stringify({ tokens: { access_token: 'sk-plan-canary' } }),
  );
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-plan-run-'));
  dirs.push(dir);
  return dir;
}

async function labelled(kind: 'container' | 'volume' | 'network', attempt: string) {
  const filter = `label=${LABEL}=${attempt}`;
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', filter]
      : [kind, 'ls', '-q', '--filter', filter];

  const { stdout } = await execa('docker', args);
  return stdout.split('\n').filter((line) => line !== '');
}

describe('autonomous two-step plan', () => {
  it('advances one linear branch, lets step 2 see step 1, and verifies the finished head', async () => {
    const images = await resolveRuntimeImages();
    const workdir = await scratch();
    const artifactsRoot = await scratch();

    const planFile = join(workdir, 'plan.yml');
    await writeFile(planFile, PLAN);

    const manifestPath = join(workdir, 'execution-manifest.yml');
    await writeManifest(
      manifestPath,
      await buildManifest({ planFile, manifestPath, repoPath: repo.dir }),
    );

    const approved = await validateManifest(await loadManifest(manifestPath), {
      repoPath: repo.dir,
    });
    expect(approved.images).toEqual(images);

    const store = StateStore.open(join(workdir, 'state.db'));
    stores.push(store);

    const report: PlanReport = await runPlan({
      approved,
      store,
      artifactsRoot,
      manifestPath,
      sourceCodexHome: root,
      storeDirectory: join(root, 'store'),
      dependencyCacheDirectory: join(root, 'deps'),
      injection: {
        agent: stub,
        agentEnv: {
          STUB_MODE: 'write',
          STUB_EVENTS: cannedEvents(),
          STUB_APPEND_PATH: NOTES,
          STUB_APPEND_CONTENT: 'step\n',
        },
      },
    });

    expect(report.failure).toBeUndefined();
    expect(report.state).toBe('completed');
    expect(report.finalVerification?.status).toBe('pass');

    // One stable branch, advanced linearly: base → step 1 → step 2.
    const branch = 'ai-harness/two-step-plan';
    expect(report.branch).toBe(branch);
    expect(await git(repo.dir, ['rev-parse', branch])).toBe(report.head);
    expect(await git(repo.dir, ['rev-list', '--count', branch])).toBe('3');

    const [first, second] = report.steps;
    expect(first?.status).toBe('completed');
    expect(second?.status).toBe('completed');
    expect(second?.commit).toBe(report.head);
    expect(await git(repo.dir, ['rev-parse', `${second?.commit ?? ''}^`])).toBe(first?.commit);
    expect(await git(repo.dir, ['rev-parse', `${first?.commit ?? ''}^`])).toBe(
      approved.baseCommit,
    );

    // Step 2 was seeded from step 1's accepted commit, not from the approved base.
    expect(await git(repo.dir, ['show', `${first?.commit ?? ''}:${NOTES}`])).toBe('step');
    expect(await git(repo.dir, ['show', `${second?.commit ?? ''}:${NOTES}`])).toBe('step\nstep');

    // The user's own branch and worktree are untouched.
    expect(await git(repo.dir, ['rev-parse', 'HEAD'])).toBe(approved.baseCommit);
    expect(await git(repo.dir, ['status', '--porcelain'])).toBe('');

    // Trailers name the plan and the step that produced each commit.
    const message = await git(repo.dir, ['log', '-1', '--format=%B', second?.commit ?? '']);
    expect(message).toContain('AI-Harness-Plan: two-step-plan');
    expect(message).toContain('AI-Harness-Step: second-step');

    // Evidence is per attempt and non-overwriting; snapshots are pruned once nothing needs them.
    const planRoot = join(artifactsRoot, 'two-step-plan');
    expect(await readdir(join(planRoot, 'snapshots'))).toEqual([]);
    expect(await readdir(join(planRoot, 'reports'))).toEqual(['invocation-1.json']);
    expect(await readdir(join(planRoot, 'final'))).toEqual(['run-1']);
    for (const entry of report.steps) {
      const runs = await readdir(join(planRoot, 'steps', entry.id, entry.attempt ?? ''));
      expect(runs).toEqual(['run-1']);
    }

    const stored = JSON.parse(
      await readFile(join(planRoot, 'reports', 'invocation-1.json'), 'utf8'),
    ) as PlanReport;
    expect(stored.head).toBe(report.head);

    // No attempt-scoped resource survived either step.
    for (const entry of report.steps) {
      const attempt = entry.attempt ?? '';
      await expect(labelled('container', attempt)).resolves.toEqual([]);
      await expect(labelled('volume', attempt)).resolves.toEqual([]);
      await expect(labelled('network', attempt)).resolves.toEqual([]);
    }
  }, 900_000);
});
