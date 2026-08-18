import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import type { RuntimeImage } from '../../src/docker/images.js';
import { loadPlan } from '../../src/plan/load.js';
import {
  buildManifest,
  loadManifest,
  validateManifest,
  writeManifest,
} from '../../src/plan/execution-manifest.js';
import { runPlan, type PlanReport } from '../../src/run/coordinator.js';
import { StateStore } from '../../src/state/store.js';
import {
  APPLICATION_LOG_FILE,
  BEHAVIORAL_LOG_FILE,
  RUNTIME_ARTIFACT_DIR,
  RUNTIME_RESULT_FILE,
  type RuntimeCheckResult,
} from '../../src/verify/runtime.js';
import { DEPENDENCY_CACHE } from '../helpers/deps.js';
import { createM2Repo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

const AUTH_CANARY = 'sk-runtime-plan-canary';
const CHECKER_PATH = 'enactment-checks/health-check.mjs';

const SERVER = `import http from 'node:http';

http
  .createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      return;
    }
    response.writeHead(404);
    response.end();
  })
  .listen(Number(process.env.PORT), process.env.HOST, () => {
    console.log('listening on ' + process.env.HOST + ':' + process.env.PORT);
  });
`;

const CHECKER = `const url = process.env.ENACTMENT_APP_URL;
const response = await fetch(url + '/health');
const body = await response.text();
if (response.status !== 200 || body !== 'ok') {
  console.error('unexpected ' + response.status + ': ' + body);
  process.exit(1);
}
console.log('behavioral check passed against ' + url);
`;

const PLAN = [
  'version: 1',
  'id: runtime-plan',
  'steps:',
  '  - type: task',
  '    complexity: low',
  '    risk: standard',
  '    id: serve-health',
  '    observable_behavior: Serve a health endpoint from src/server.js.',
  '    implementation_paths:',
  '      - src/server.js',
  '    verification:',
  '      commands:',
  '        - ["node", "--version"]',
  '      runtime:',
  '        start_command: ["node", "src/server.js"]',
  '        port: 3000',
  '        readiness_path: /health',
  '        behavioral_commands:',
  `          - ["node", "${CHECKER_PATH}"]`,
  '    timeouts:',
  '      connectivity_smoke_seconds: 20',
  '      agent_seconds: 30',
  '      termination_grace_seconds: 2',
  'final_verification:',
  '  commands:',
  '    - ["node", "--version"]',
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
  root = await mkdtemp(join(tmpdir(), 'enactment-runtime-plan-'));

  await writeFile(join(root, AUTH_FILE), JSON.stringify({ tokens: { access_token: AUTH_CANARY } }));

  await mkdir(join(repo.dir, 'enactment-checks'), { recursive: true });
  await writeFile(join(repo.dir, CHECKER_PATH), CHECKER);
  await git(repo.dir, ['add', '-A']);
  await git(repo.dir, ['commit', '-q', '--no-verify', '-m', 'Add behavioral checker']);
  repo.commit = await git(repo.dir, ['rev-parse', 'HEAD']);
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
  const dir = await mkdtemp(join(tmpdir(), 'enactment-runtime-plan-run-'));
  dirs.push(dir);
  return dir;
}

describe('runtime-verified plan through the production path', () => {
  it(
    'prepares, approves, runs, gates on the runtime check and commits one branch',
    async () => {
      const workdir = await scratch();
      const artifactsRoot = await scratch();

      const planFile = join(workdir, 'plan.yml');
      await writeFile(planFile, PLAN);

      // The authoring rule the RUNBOOK states: the checker is not in any agent-writable scope.
      const { plan } = await loadPlan(planFile);
      const step = plan.steps[0];
      if (step === undefined) throw new Error('plan has no step');
      expect(step.implementation_paths).not.toContain(CHECKER_PATH);
      expect(step.implementation_paths.some((path) => CHECKER_PATH.startsWith(path))).toBe(false);

      const manifestPath = join(workdir, 'execution-manifest.yml');
      await writeManifest(
        manifestPath,
        (await buildManifest({ planFile, manifestPath, repoPath: repo.dir })).manifest,
      );

      const approved = await validateManifest(await loadManifest(manifestPath), {
        repoPath: repo.dir,
      });

      const store = StateStore.open(join(workdir, 'state.db'));
      stores.push(store);

      const report: PlanReport = await runPlan({
        approved,
        store,
        artifactsRoot,
        manifestPath,
        sourceCodexHome: root,
        storeDirectory: join(root, 'store'),
        dependencyCacheDirectory: DEPENDENCY_CACHE,
        injection: {
          codex: stub,
          agentEnv: {
            STUB_MODE: 'write',
            STUB_EVENTS: cannedEvents(),
            STUB_WRITE_PATH: 'src/server.js',
            STUB_WRITE_CONTENT: SERVER,
          },
        },
      });

      expect(report.failure).toBeUndefined();
      expect(report.state).toBe('completed');
      expect(report.finalVerification?.status).toBe('pass');

      const branch = 'enactment/runtime-plan';
      expect(report.branch).toBe(branch);
      const changed = await git(repo.dir, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        report.head ?? '',
      ]);
      expect(changed.split('\n')).toEqual(['src/server.js']);

      const runDir = join(artifactsRoot, 'runtime-plan', 'steps', 'serve-health');
      const [attempt] = await readdir(runDir);
      if (attempt === undefined) throw new Error('no attempt directory');
      const evidence = join(runDir, attempt, 'run-1');

      const stored = JSON.parse(
        await readFile(join(evidence, RUNTIME_ARTIFACT_DIR, RUNTIME_RESULT_FILE), 'utf8'),
      ) as RuntimeCheckResult;
      expect(stored.status).toBe('pass');
      expect(stored.stage).toBeUndefined();
      expect(stored.startCommand).toEqual(['node', 'src/server.js']);
      expect(stored.readinessUrl).toMatch(/^http:\/\/enactment-app-[0-9a-f]+:3000\/health$/);
      expect(stored.commands).toHaveLength(1);

      const application = await readFile(
        join(evidence, RUNTIME_ARTIFACT_DIR, APPLICATION_LOG_FILE),
        'utf8',
      );
      const behavioral = await readFile(
        join(evidence, RUNTIME_ARTIFACT_DIR, BEHAVIORAL_LOG_FILE),
        'utf8',
      );
      expect(application).toContain('listening on 0.0.0.0:3000');
      expect(behavioral).toContain('behavioral check passed against');

      const manifest = JSON.parse(await readFile(join(evidence, 'run-manifest.json'), 'utf8')) as {
        runtime_check?: { status: string; verifier_image_id: string };
      };
      expect(manifest.runtime_check?.status).toBe('pass');
      expect(manifest.runtime_check?.verifier_image_id).toBe(approved.images.verifier.id);

      // §32: no credential may reach an artifact, runtime evidence included.
      for (const text of [application, behavioral, JSON.stringify(stored)]) {
        expect(text).not.toContain(AUTH_CANARY);
      }

      await git(repo.dir, ['branch', '-D', branch]);
    },
    1_800_000,
  );
});
