import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import type { RuntimeImage } from '../../src/docker/images.js';
import {
  runSinglePlanStep,
  type RunPhase,
  type RunReport,
  type StepEvent,
} from '../../src/run/bridge.js';
import {
  APPLICATION_LOG_FILE,
  BEHAVIORAL_LOG_FILE,
  RUNTIME_ARTIFACT_DIR,
  RUNTIME_RESULT_FILE,
} from '../../src/verify/runtime.js';
import { RUNTIME_READINESS_TIMEOUT_SECONDS } from '../../src/verify/runtime-policy.js';
import { newAttemptId, runtimeContainerName } from '../../src/volume/naming.js';
import { planDocument } from '../helpers/plan.js';
import { commitAll, createM2Repo, git, removePlanBranches, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

const ATTEMPT_LABEL = 'ai-harness.attempt';

/** Listens only when the harness sets PORT, so the same module is importable by the suite. */
const SERVER = `import http from 'node:http';

export function health() {
  return 'ok';
}

if (process.env.PORT) {
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
}
`;

/** Consumes the build output a static verification command produced in the same workspace. */
const BUILT_SERVER = `import http from 'node:http';
import { readFileSync } from 'node:fs';

const built = readFileSync(new URL('./built.txt', import.meta.url), 'utf8').trim();

http
  .createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(built);
      return;
    }
    response.writeHead(404);
    response.end();
  })
  .listen(Number(process.env.PORT), process.env.HOST, () => {
    console.log('serving build output: ' + built);
  });
`;

const TEST_SOURCE = `import { health } from '../src/server.js';

describe('health', () => {
  it('reports ok', () => {
    expect(health()).toBe('ok');
  });
});
`;

/** Passes without any implementation, so RED discovers the expected ID and it does not fail. */
const PASSING_TEST_SOURCE = `describe('health', () => {
  it('reports ok', () => {
    expect(true).toBe(true);
  });
});
`;

/** Committed outside every agent-writable scope, as the V1 authoring rule requires. */
const CHECKER = `const url = process.env.HARNESS_APP_URL;
if (!url) {
  console.error('HARNESS_APP_URL is not set');
  process.exit(2);
}

const response = await fetch(url + '/health');
const body = await response.text();
if (response.status !== 200) {
  console.error('unexpected status ' + response.status);
  process.exit(1);
}
console.log('checker read: ' + body);
`;

const FAILING_CHECKER = `console.error('behavioral expectation not met');
process.exit(1);
`;

/** Writes into the shared verifier workspace; nothing it writes may reach the commit. */
const TAMPERING_CHECKER = `import { writeFileSync } from 'node:fs';
writeFileSync('/workspace/src/tampered.js', 'export const tampered = true;\\n');
console.log('tampered');
`;

let repo: TargetRepo;
let root: string;
let stub: RuntimeImage;
const dirs: string[] = [];

beforeAll(async () => {
  stub = await stubAgentImage();
  repo = await createM2Repo();
  root = await mkdtemp(join(tmpdir(), 'harness-m6-'));

  const source = join(root, 'codex-source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, AUTH_FILE), JSON.stringify({ tokens: { access_token: 'm6-canary' } }));

  await mkdir(join(repo.dir, 'harness-checks'), { recursive: true });
  await writeFile(join(repo.dir, 'harness-checks/health-check.mjs'), CHECKER);
  await writeFile(join(repo.dir, 'harness-checks/failing-check.mjs'), FAILING_CHECKER);
  await writeFile(join(repo.dir, 'harness-checks/tampering-check.mjs'), TAMPERING_CHECKER);
  repo.commit = await commitAll(repo.dir, 'Add behavioral checkers');
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await removePlanBranches(repo.dir);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface RuntimeBlock {
  startCommand?: string[];
  port?: number;
  readinessPath?: string;
  behavioralCommands?: string[][];
}

function runtimeLines(block: RuntimeBlock | undefined): string[] {
  if (block === undefined) return [];

  return [
    '  runtime:',
    `    start_command: ${JSON.stringify(block.startCommand ?? ['node', 'src/server.js'])}`,
    `    port: ${String(block.port ?? 3000)}`,
    `    readiness_path: ${block.readinessPath ?? '/health'}`,
    '    behavioral_commands:',
    ...(block.behavioralCommands ?? [['node', 'harness-checks/health-check.mjs']]).map(
      (command) => `      - ${JSON.stringify(command)}`,
    ),
  ];
}

async function taskPlan(
  options: { runtime?: RuntimeBlock; commands?: string[][] } = {},
): Promise<string> {
  const dir = await mkdtemp(join(root, 'plan-'));
  dirs.push(dir);
  const path = join(dir, 'plan.yml');

  await writeFile(
    path,
    planDocument([
      'type: task',
      'complexity: low',
      'risk: standard',
      'id: serve-health',
      'observable_behavior: Serve a health endpoint.',
      'implementation_paths:',
      '  - src/server.js',
      'verification:',
      '  commands:',
      ...(options.commands ?? [['node', '--version']]).map(
        (command) => `    - ${JSON.stringify(command)}`,
      ),
      ...runtimeLines(options.runtime),
      'timeouts:',
      '  connectivity_smoke_seconds: 20',
      '  agent_seconds: 6',
      '  termination_grace_seconds: 2',
    ]),
  );

  return path;
}

async function codeBehaviorPlan(runtime: RuntimeBlock | undefined): Promise<string> {
  const dir = await mkdtemp(join(root, 'plan-'));
  dirs.push(dir);
  const path = join(dir, 'plan.yml');

  await writeFile(
    path,
    planDocument([
      'type: code_behavior',
      'complexity: low',
      'risk: standard',
      'id: serve-health-tests-first',
      'observable_behavior: Serve a health endpoint, tests first.',
      'implementation_paths:',
      '  - src/server.js',
      'test_paths:',
      '  - test/server.test.js',
      'expected_test_ids:',
      '  - health reports ok',
      'verification:',
      '  test_command: ["npx", "--no-install", "vitest", "run", "--globals"]',
      ...runtimeLines(runtime),
      'timeouts:',
      '  connectivity_smoke_seconds: 20',
      '  agent_seconds: 6',
      '  termination_grace_seconds: 2',
    ]),
  );

  return path;
}

interface RunOutcome {
  report: RunReport;
  artifacts: string;
  phases: RunPhase[];
  events: StepEvent[];
  attempt: string;
}

async function run(
  planFile: string,
  env: Record<string, string>,
  attempt = newAttemptId(),
): Promise<RunOutcome> {
  const artifacts = await mkdtemp(join(tmpdir(), 'harness-m6-artifacts-'));
  dirs.push(artifacts);

  const phases: RunPhase[] = [];
  const events: StepEvent[] = [];

  const report = await runSinglePlanStep({
    planFile,
    repoPath: repo.dir,
    artifactDir: artifacts,
    sourceCodexHome: join(root, 'codex-source'),
    storeDirectory: join(root, 'store'),
    dependencyCacheDirectory: join(root, 'deps'),
    injection: { codex: stub, agentEnv: env, attempt },
    onPhase: (phase) => void phases.push(phase),
    onEvent: (event) => void events.push(event),
  });

  return { report, artifacts, phases, events, attempt };
}

function taskEnv(source = SERVER, path = 'src/server.js'): Record<string, string> {
  return {
    STUB_MODE: 'write',
    STUB_EVENTS: cannedEvents(),
    STUB_WRITE_PATH: path,
    STUB_WRITE_CONTENT: source,
  };
}

function codeBehaviorEnv(): Record<string, string> {
  return {
    STUB_MODE_TESTS: 'write',
    STUB_EVENTS_TESTS: cannedEvents(),
    STUB_WRITE_PATH_TESTS: 'test/server.test.js',
    STUB_WRITE_CONTENT_TESTS: TEST_SOURCE,
    STUB_MODE_IMPLEMENTATION: 'write',
    STUB_EVENTS_IMPLEMENTATION: cannedEvents(),
    STUB_WRITE_PATH_IMPLEMENTATION: 'src/server.js',
    STUB_WRITE_CONTENT_IMPLEMENTATION: SERVER,
  };
}

function order(phases: RunPhase[], expected: RunPhase[]): number[] {
  return expected.map((phase) => phases.indexOf(phase));
}

async function labelled(kind: 'container' | 'volume' | 'network', attempt: string): Promise<string[]> {
  const filter = `label=${ATTEMPT_LABEL}=${attempt}`;
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', filter]
      : [kind, 'ls', '-q', '--filter', filter];
  const { stdout } = await execa('docker', args);
  return stdout.split('\n').filter((line) => line !== '');
}

async function expectNoResources(attempt: string): Promise<void> {
  await expect(labelled('container', attempt)).resolves.toEqual([]);
  await expect(labelled('volume', attempt)).resolves.toEqual([]);
  await expect(labelled('network', attempt)).resolves.toEqual([]);
}

function branchExists(): Promise<boolean> {
  return git(repo.dir, ['rev-parse', '--verify', 'refs/heads/ai-harness/harness-test-plan'])
    .then(() => true)
    .catch(() => false);
}

describe('runtime-gated task step', () => {
  it(
    'runs agent, static commands, runtime, review and commit in that order',
    async () => {
      const plan = await taskPlan({ runtime: {} });
      const { report, phases, artifacts, attempt } = await run(plan, taskEnv());

      expect(report.status).toBe('succeeded');
      const [agent, verify, runtime, review, commit] = order(phases, [
        'agent',
        'verify',
        'runtime',
        'review',
        'commit',
      ]);
      expect(agent).toBeGreaterThanOrEqual(0);
      expect(verify).toBeGreaterThan(agent ?? 0);
      expect(runtime).toBeGreaterThan(verify ?? 0);
      expect(review).toBeGreaterThan(runtime ?? 0);
      expect(commit).toBeGreaterThan(review ?? 0);

      const manifest = JSON.parse(
        await readFile(join(artifacts, 'run-manifest.json'), 'utf8'),
      ) as { runtime_check?: { status: string; stage?: string } };
      expect(manifest.runtime_check?.status).toBe('pass');

      const dir = join(artifacts, RUNTIME_ARTIFACT_DIR);
      for (const file of [RUNTIME_RESULT_FILE, APPLICATION_LOG_FILE, BEHAVIORAL_LOG_FILE]) {
        await expect(access(join(dir, file))).resolves.toBeUndefined();
      }
      expect(await readFile(join(dir, BEHAVIORAL_LOG_FILE), 'utf8')).toContain('checker read: ok');

      await expectNoResources(attempt);
    },
    900_000,
  );

  it(
    'shares one disposable workspace between static and runtime verification',
    async () => {
      const plan = await taskPlan({
        commands: [
          [
            'node',
            '-e',
            "require('node:fs').writeFileSync('src/built.txt', 'built-by-static-command')",
          ],
        ],
        runtime: {},
      });
      const { report, artifacts } = await run(plan, taskEnv(BUILT_SERVER));

      // The application reads a file no snapshot contains: only the static command created it.
      expect(report.status).toBe('succeeded');
      expect(await readFile(join(artifacts, RUNTIME_ARTIFACT_DIR, APPLICATION_LOG_FILE), 'utf8')).toContain(
        'serving build output: built-by-static-command',
      );

      const changed = await git(repo.dir, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        report.commit ?? '',
      ]);
      // The build output belongs to the disposable copy, never to the commit.
      expect(changed.split('\n')).toEqual(['src/server.js']);
    },
    900_000,
  );

  it(
    'commits the exact pre-runtime implementation snapshot',
    async () => {
      const plan = await taskPlan({
        runtime: { behavioralCommands: [['node', 'harness-checks/tampering-check.mjs']] },
      });
      const { report } = await run(plan, taskEnv());

      expect(report.status).toBe('succeeded');
      const changed = await git(repo.dir, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        report.commit ?? '',
      ]);
      expect(changed.split('\n')).toEqual(['src/server.js']);
      expect(changed).not.toContain('tampered');
    },
    900_000,
  );

  it(
    'reports verification_failed for a behavioral failure, with no candidate and no branch',
    async () => {
      const plan = await taskPlan({
        runtime: { behavioralCommands: [['node', 'harness-checks/failing-check.mjs']] },
      });
      const { report, events, artifacts, attempt } = await run(plan, taskEnv());

      expect(report.status).toBe('failed');
      expect(report.failedPhase).toBe('runtime');
      expect(report.category).toBe('verification_failed');
      expect(events.some((event) => event.kind === 'candidate')).toBe(false);
      expect(await branchExists()).toBe(false);

      expect(
        await readFile(join(artifacts, RUNTIME_ARTIFACT_DIR, BEHAVIORAL_LOG_FILE), 'utf8'),
      ).toContain('behavioral expectation not met');
      await expectNoResources(attempt);
    },
    900_000,
  );

  it(
    'names the reason when the application exits before it is ready',
    async () => {
      const plan = await taskPlan({ runtime: {} });
      const started = Date.now();
      const { report, artifacts } = await run(
        plan,
        taskEnv("console.error('cannot bind: configuration missing');\nprocess.exit(1);\n"),
      );
      const elapsed = Date.now() - started;

      expect(report.status).toBe('failed');
      expect(report.failedPhase).toBe('runtime');
      expect(report.category).toBe('verification_failed');
      // The operator should not have to open an artifact to learn what happened.
      expect(report.message).toMatch(/exited/i);

      const manifest = JSON.parse(await readFile(join(artifacts, 'run-manifest.json'), 'utf8')) as {
        runtime_check?: { status: string; stage?: string; reason?: string };
      };
      expect(manifest.runtime_check?.status).toBe('fail');
      expect(manifest.runtime_check?.stage).toBe('readiness');
      expect(manifest.runtime_check?.reason).toMatch(/exited/i);

      expect(
        await readFile(join(artifacts, RUNTIME_ARTIFACT_DIR, APPLICATION_LOG_FILE), 'utf8'),
      ).toContain('cannot bind: configuration missing');

      // A dead application must not cost the whole readiness budget.
      expect(elapsed).toBeLessThan(RUNTIME_READINESS_TIMEOUT_SECONDS * 1000);
    },
    900_000,
  );

  it(
    'reports internal_error when the runtime container cannot be created',
    async () => {
      const attempt = newAttemptId();
      const application = runtimeContainerName(attempt);
      // A real Docker create failure — the name is taken. Log-capture and artifact-write
      // failures raise the same typed error into the same catch, and are covered hermetically.
      await execa('docker', ['create', '--name', application, 'busybox:latest', 'true']);

      try {
        const plan = await taskPlan({ runtime: {} });
        const { report, events } = await run(plan, taskEnv(), attempt);

        expect(report.status).toBe('failed');
        expect(report.failedPhase).toBe('runtime');
        expect(report.category).toBe('internal_error');
        expect(events.some((event) => event.kind === 'candidate')).toBe(false);
        expect(await branchExists()).toBe(false);
      } finally {
        await execa('docker', ['rm', '--force', application], { reject: false });
      }
    },
    900_000,
  );

  it(
    'starts no runtime container for a step that declares no runtime block',
    async () => {
      const plan = await taskPlan({});
      const { report, phases, artifacts, attempt } = await run(plan, taskEnv());

      expect(report.status).toBe('succeeded');
      expect(phases).not.toContain('runtime');
      await expect(access(join(artifacts, RUNTIME_ARTIFACT_DIR))).rejects.toThrow();

      const manifest = JSON.parse(await readFile(join(artifacts, 'run-manifest.json'), 'utf8')) as {
        runtime_check?: unknown;
      };
      expect(manifest.runtime_check).toBeUndefined();
      await expectNoResources(attempt);
    },
    900_000,
  );
});

describe('runtime-gated code_behavior step', () => {
  it(
    'runs baseline, tests, RED, implementation, GREEN, static commands, runtime, review, commit',
    async () => {
      const plan = await codeBehaviorPlan({});
      const { report, phases, artifacts, attempt } = await run(plan, codeBehaviorEnv());

      expect(report.status).toBe('succeeded');
      const indexes = order(phases, [
        'baseline',
        'tests',
        'red',
        'implementation',
        'green',
        'verify',
        'runtime',
        'review',
        'commit',
      ]);
      expect(indexes.every((index) => index >= 0)).toBe(true);
      expect(indexes).toEqual([...indexes].sort((left, right) => left - right));

      const manifest = JSON.parse(await readFile(join(artifacts, 'run-manifest.json'), 'utf8')) as {
        runtime_check?: { status: string };
      };
      expect(manifest.runtime_check?.status).toBe('pass');
      await expectNoResources(attempt);
    },
    900_000,
  );

  it(
    'never reaches the runtime check after an invalid RED',
    async () => {
      // A test that passes with no implementation at all: the expected ID is discovered and
      // does not fail, which is exactly what an invalid RED is.
      const plan = await codeBehaviorPlan({});
      const { report, phases } = await run(plan, {
        ...codeBehaviorEnv(),
        STUB_WRITE_CONTENT_TESTS: PASSING_TEST_SOURCE,
      });

      expect(report.status).toBe('failed');
      expect(report.failedPhase).toBe('red');
      expect(report.category).toBe('red_invalid');
      expect(phases).not.toContain('runtime');
    },
    900_000,
  );

  it(
    'never reaches the runtime check after a failed GREEN',
    async () => {
      const plan = await codeBehaviorPlan({});
      const { report, phases } = await run(plan, {
        ...codeBehaviorEnv(),
        // An implementation that does not satisfy the frozen tests.
        STUB_WRITE_CONTENT_IMPLEMENTATION: "export function health() {\n  return 'broken';\n}\n",
      });

      expect(report.status).toBe('failed');
      expect(report.category).toBe('verification_failed');
      expect(report.failedPhase).toBe('green');
      expect(phases).not.toContain('runtime');
    },
    900_000,
  );

  it(
    'never reaches the runtime check after a failed static command',
    async () => {
      const dir = await mkdtemp(join(root, 'plan-'));
      dirs.push(dir);
      const path = join(dir, 'plan.yml');
      await writeFile(
        path,
        planDocument([
          'type: task',
          'complexity: low',
          'risk: standard',
          'id: serve-health',
          'observable_behavior: Serve a health endpoint.',
          'implementation_paths:',
          '  - src/server.js',
          'verification:',
          '  commands:',
          '    - ["node", "-e", "process.exit(9)"]',
          ...runtimeLines({}),
          'timeouts:',
          '  connectivity_smoke_seconds: 20',
          '  agent_seconds: 6',
          '  termination_grace_seconds: 2',
        ]),
      );

      const { report, phases, attempt } = await run(path, taskEnv());

      expect(report.status).toBe('failed');
      expect(report.failedPhase).toBe('verify');
      expect(report.category).toBe('verification_failed');
      expect(phases).not.toContain('runtime');
      await expectNoResources(attempt);
    },
    900_000,
  );
});
