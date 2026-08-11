import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import { resolveRuntimeImages, type RuntimeImage } from '../../src/docker/images.js';
import type { RunInjection } from '../../src/run/inject.js';
import {
  runSinglePlanStep,
  RUN_PHASES,
  type RunPhase,
  type RunReport,
  type StepEvent,
} from '../../src/run/bridge.js';
import {
  createTargetRepo,
  git,
  removePlanBranches,
  removeRepo,
  type TargetRepo,
} from '../helpers/repo.js';
import { planDocument } from '../helpers/plan.js';
import { cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

const CANARY = 'sk-orchestrator-canary-77d3f19a';
const LABEL = 'enactment.attempt';
const M1_PHASES = [
  'export',
  'setup',
  'workspace',
  'connectivity',
  'agent',
  'diff',
  'verify',
  'review',
  'commit',
] as const satisfies readonly RunPhase[];

const SLUGIFY = `export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

let repo: TargetRepo;
let root: string;
let planFile: string;
let stub: RuntimeImage;
let runnerScript: string;
const dirs: string[] = [];

/** The stub writes the implementation, so the whole pipeline can reach a real commit. */
function stubEnv(mode = 'write'): Record<string, string> {
  return {
    STUB_MODE: mode,
    STUB_EVENTS: cannedEvents(),
    STUB_WRITE_PATH: 'src/slugify.js',
    STUB_WRITE_CONTENT: SLUGIFY,
  };
}

/** The only seam a test may use: an explicit runtime identity, recorded like any other. */
function injection(mode = 'write'): RunInjection {
  return { codex: stub, agentEnv: stubEnv(mode) };
}

beforeAll(async () => {
  stub = await stubAgentImage();

  repo = await createTargetRepo();
  root = await mkdtemp(join(tmpdir(), 'enactment-run-'));

  const source = join(root, 'codex-source');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, AUTH_FILE),
    JSON.stringify({ tokens: { access_token: CANARY, refresh_token: `refresh-${CANARY}` } }),
  );

  planFile = join(root, 'plan.yml');
  await writeFile(
    planFile,
    planDocument([
        'type: task',
        'complexity: low',
        'risk: standard',
        'id: add-slugify',
        'observable_behavior: Implement the slugify function in src/slugify.js',
        'implementation_paths:',
        '  - src/slugify.js',
        'verification:',
        '  commands:',
        '    - ["npx", "--no-install", "vitest", "run", "--config", "vitest.config.js"]',
        'timeouts:',
        '  connectivity_smoke_seconds: 20',
        '  agent_seconds: 15',
        '  termination_grace_seconds: 2',
    ]),
  );

  // The production CLI has no image or environment override, so the interrupt test drives
  // `runSinglePlanStep` in a child process of its own rather than through an escape hatch.
  runnerScript = join(root, 'run-with-stub.mjs');
  await writeFile(
    runnerScript,
    [
      "import { appendFile, writeFile } from 'node:fs/promises';",
      `import { runSinglePlanStep } from ${JSON.stringify(join(process.cwd(), 'dist/run/bridge.js'))};`,
      'const controller = new AbortController();',
      "for (const signal of ['SIGINT', 'SIGTERM']) {",
      '  process.on(signal, () => { controller.abort(); });',
      '}',
      'const report = await runSinglePlanStep({',
      '  ...JSON.parse(process.env.ENACTMENT_TEST_RUN),',
      '  onPhase: (phase) => appendFile(process.env.ENACTMENT_TEST_PHASES, `${phase}\\n`),',
      '  signal: controller.signal,',
      '});',
      'await writeFile(process.env.ENACTMENT_TEST_REPORT, JSON.stringify(report));',
      "process.exit(report.status === 'succeeded' ? 0 : 1);",
      '',
    ].join('\n'),
  );
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await removePlanBranches(repo.dir);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Scoped to one attempt on purpose: a sweep for every harness label would report resources
 * another test file is legitimately using, which is both a false failure and a false pass
 * depending on the timing.
 */
async function labelled(
  kind: 'container' | 'volume' | 'network',
  attempt: string,
): Promise<string[]> {
  const filter = `label=${LABEL}=${attempt}`;
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

async function artifactDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'enactment-artifacts-'));
  dirs.push(dir);
  return dir;
}

async function run(
  overrides: Partial<Parameters<typeof runSinglePlanStep>[0]> = {},
): Promise<{ report: RunReport; artifacts: string }> {
  const artifacts = await artifactDir();

  const report = await runSinglePlanStep({
    planFile,
    repoPath: repo.dir,
    artifactDir: artifacts,
    sourceCodexHome: join(root, 'codex-source'),
    storeDirectory: join(root, 'store'),
    dependencyCacheDirectory: join(root, 'deps'),
    injection: injection(),
    ...overrides,
  });

  return { report, artifacts };
}

async function reviewPlan(risk: 'standard' | 'high'): Promise<string> {
  const file = join(await artifactDir(), `plan-${risk}.yml`);
  await writeFile(
    file,
    planDocument([
      'type: task',
      'complexity: low',
      `risk: ${risk}`,
      'id: review-probe',
      'observable_behavior: Write the review probe.',
      'implementation_paths:',
      '  - src/review-probe.js',
      'verification:',
      '  commands:',
      '    - ["node", "--check", "src/review-probe.js"]',
    ]),
  );
  return file;
}

/** Poll the child's phase log until it enters `phase`, so the interrupt is not a race. */
async function reachedPhase(phasesFile: string, phase: RunPhase): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if ((await readFile(phasesFile, 'utf8')).split('\n').includes(phase)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`run never reached the ${phase} phase`);
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

describe('orchestrator', () => {
  it('drives every phase to a commit with a complete artifact set', async () => {
    const { report, artifacts } = await run();

    expect(report.status).toBe('succeeded');
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);

    const message = await git(repo.dir, ['log', '-1', '--format=%B', report.commit ?? '']);
    expect(message).toContain('Enactment-Plan: harness-test-plan');
    expect(message).toContain('Enactment-Step: add-slugify');

    const files = (await walk(artifacts)).map((path) => path.replace(`${artifacts}/`, ''));
    expect(files).toEqual(
      expect.arrayContaining([
        'run-manifest.json',
        'prompt.txt',
        'agent-events.jsonl',
        'verification.json',
        'review/scan.json',
        'review/review.json',
        'review/reviewer.log',
        'source-diff.json',
        'proxy-records.jsonl',
      ]),
    );
    expect(files.some((path) => path.startsWith('logs/'))).toBe(true);
    expect(files.some((path) => path.startsWith('snapshots/'))).toBe(true);
  }, 900_000);

  it('runs the phases in order, with the smoke test ahead of the agent', async () => {
    const seen: RunPhase[] = [];
    await run({ onPhase: (phase) => void seen.push(phase) });

    expect(seen).toEqual(RUN_PHASES.filter((phase) => seen.includes(phase)));
    expect(seen.indexOf('connectivity')).toBeLessThan(seen.indexOf('agent'));
    expect(seen.indexOf('agent')).toBeLessThan(seen.indexOf('verify'));
    expect(seen.indexOf('verify')).toBeLessThan(seen.indexOf('review'));
    expect(seen.indexOf('review')).toBeLessThan(seen.indexOf('commit'));
    expect(seen.indexOf('verify')).toBeLessThan(seen.indexOf('commit'));
  }, 900_000);

  /**
   * A failed attempt workspace is disposable, so what a phase failure owes is a truthful
   * report and a clean teardown — not a restored workspace. The failure modes that actually
   * dirty the workspace live in `workspace-disposal.test.ts`; what this matrix pins is that
   * every phase reports its own failure, commits nothing, and leaks nothing.
   */
  it.each(M1_PHASES.filter((phase) => phase !== 'commit'))(
    'reports a failure injected in the %s phase, commits nothing, and leaves no resources',
    async (phase) => {
      const before = await git(repo.dir, ['rev-list', '--all', '--count']);

      const { report, artifacts } = await run({
        onPhase: (current) => {
          if (current === phase) throw new Error(`injected ${phase} failure`);
        },
      });

      expect(report.status).toBe('failed');
      expect(report.failedPhase).toBe(phase);
      expect(report.commit).toBeUndefined();
      expect(await git(repo.dir, ['rev-list', '--all', '--count'])).toBe(before);

      const manifest = JSON.parse(
        await readFile(join(artifacts, 'run-manifest.json'), 'utf8'),
      ) as { restoration?: unknown };

      // Nothing claims a restoration, because nothing performs one.
      expect(manifest.restoration).toBeUndefined();

      await expectNoResources(report.attempt);
    },
    900_000,
  );

  it('classifies an agent timeout and commits nothing', async () => {
    const { report, artifacts } = await run({ injection: injection('hang') });

    expect(report.status).toBe('failed');
    expect(report.failedPhase).toBe('agent');
    expect(report.category).toBe('agent_timeout');
    expect(report.commit).toBeUndefined();

    const manifest = JSON.parse(
      await readFile(join(artifacts, 'run-manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect((manifest.result as Record<string, unknown>).category).toBe('agent_timeout');
  }, 900_000);

  it('leaves no attempt-labelled containers, volumes or networks behind', async () => {
    const { report } = await run();

    expect(report.status).toBe('succeeded');
    await expectNoResources(report.attempt);
  }, 900_000);

  it('reports its diagnostic phases in order, then the verified candidate, then accepting', async () => {
    const events: StepEvent[] = [];
    const { report, artifacts } = await run({ onEvent: (event) => void events.push(event) });

    expect(report.status).toBe('succeeded');

    const phases = events.flatMap((event) => (event.kind === 'phase' ? [event.phase] : []));
    expect(phases).toEqual(['preparing', 'implementation', 'verify', 'review']);

    const tail = events.slice(phases.length);
    expect(tail.map((event) => event.kind)).toEqual(['candidate', 'accepting']);

    // The acceptance candidate is recorded before the attempt enters `accepting`, so recovery
    // never needs new model output for a snapshot that was already verified.
    const candidate = tail[0];
    if (candidate?.kind !== 'candidate') throw new Error('expected a candidate event');
    const manifest = JSON.parse(await readFile(join(artifacts, 'run-manifest.json'), 'utf8')) as {
      snapshots: { implementation: string };
    };
    expect(candidate.snapshot).toBe(manifest.snapshots.implementation);
  }, 900_000);

  it('emits no candidate or accepting event when a phase fails', async () => {
    const events: StepEvent[] = [];
    const { report } = await run({
      onEvent: (event) => void events.push(event),
      onPhase: (current) => {
        if (current === 'verify') throw new Error('injected verify failure');
      },
    });

    expect(report.status).toBe('failed');
    expect(events.map((event) => event.kind)).not.toContain('candidate');
    expect(events.map((event) => event.kind)).not.toContain('accepting');
    expect(events.at(-1)).toEqual({ kind: 'phase', phase: 'verify' });
  }, 900_000);

  it('records the §20 manifest fields', async () => {
    const { artifacts } = await run();

    const manifest = JSON.parse(await readFile(join(artifacts, 'run-manifest.json'), 'utf8')) as {
      repository: { base_branch: string; base_commit: string };
      inputs: Record<string, string>;
      runtime: Record<string, string>;
    };

    expect(manifest.repository.base_branch).toBe('main');
    expect(manifest.repository.base_commit).toBe(repo.commit);
    expect(manifest.inputs.plan_hash).toMatch(/^sha256:/);
    expect(manifest.inputs.export_hash).toMatch(/^sha256:/);
    expect(manifest.inputs.network_policy_hash).toMatch(/^sha256:/);
    expect(manifest.inputs.dependency_cache_key).toMatch(/^sha256:/);
    expect(manifest.runtime.codex_image_id).toMatch(/^sha256:/);
    expect(manifest.runtime.claude_image_id).toMatch(/^sha256:/);
    expect(manifest.runtime.verifier_image_id).toMatch(/^sha256:/);
    expect(manifest.runtime.reviewer_image_id).toMatch(/^sha256:/);
    expect(manifest.runtime.setup_image_id).toMatch(/^sha256:/);
    expect(manifest.runtime.proxy_image_id).toMatch(/^sha256:/);
  }, 900_000);

  it('records the ID of the image it actually ran, not the production agent image', async () => {
    const { artifacts } = await run();
    const production = await resolveRuntimeImages();

    const manifest = JSON.parse(await readFile(join(artifacts, 'run-manifest.json'), 'utf8')) as {
      runtime: Record<string, string>;
    };

    expect(manifest.runtime.codex_image_id).toBe(stub.id);
    expect(manifest.runtime.codex_image_id).not.toBe(production.codex.id);

    // Every role the injection did not replace is still the production identity.
    expect(manifest.runtime.claude_image_id).toBe(production.claude.id);
    expect(manifest.runtime.verifier_image_id).toBe(production.verifier.id);
    expect(manifest.runtime.reviewer_image_id).toBe(production.reviewer.id);
    expect(manifest.runtime.setup_image_id).toBe(production.setup.id);
    expect(manifest.runtime.proxy_image_id).toBe(production.proxy.id);
  }, 900_000);

  it('writes no raw authentication material into the artifact tree', async () => {
    const { artifacts } = await run();

    for (const file of await walk(artifacts)) {
      expect(await readFile(file, 'utf8')).not.toContain(CANARY);
    }
  }, 900_000);

  it('tears down every attempt resource when the run is interrupted', async () => {
    const artifacts = await artifactDir();

    const scratch = await mkdtemp(join(tmpdir(), 'enactment-report-'));
    dirs.push(scratch);
    const reportFile = join(scratch, 'report.json');
    const phasesFile = join(scratch, 'phases');
    await writeFile(phasesFile, '');

    const child = execa('node', [runnerScript], {
      reject: false,
      env: {
        ENACTMENT_TEST_REPORT: reportFile,
        ENACTMENT_TEST_PHASES: phasesFile,
        ENACTMENT_TEST_RUN: JSON.stringify({
          planFile,
          repoPath: repo.dir,
          artifactDir: artifacts,
          sourceCodexHome: join(root, 'codex-source'),
          storeDirectory: join(root, 'store'),
          dependencyCacheDirectory: join(root, 'deps'),
          injection: injection(),
        }),
      },
    });

    // Interrupt at a known point rather than after a fixed wait: by the agent phase the
    // workspace volume, dependency volume, networks and proxy container all exist, which is
    // the state whose teardown this test is about.
    await reachedPhase(phasesFile, 'agent');
    child.kill('SIGINT');
    await child;

    const report = JSON.parse(await readFile(reportFile, 'utf8')) as RunReport;
    expect(report.status).toBe('failed');

    await expectNoResources(report.attempt);
  }, 900_000);

  it.each([
    [
      'standard warning',
      'standard',
      `const crypto = require('crypto');\nmodule.exports = () => crypto.pseudoRandomBytes(16);\n`,
      'succeeded',
      undefined,
    ],
    [
      'high-risk warning',
      'high',
      `const crypto = require('crypto');\nmodule.exports = () => crypto.pseudoRandomBytes(16);\n`,
      'failed',
      'review_blocked',
    ],
    [
      'standard critical',
      'standard',
      `const { spawn } = require('child_process');\nspawn('ls', ['-la'], { shell: true });\n`,
      'failed',
      'review_blocked',
    ],
  ] as const)('gates a %s finding before acceptance', async (_case, risk, content, status, category) => {
    const events: StepEvent[] = [];
    const { report, artifacts } = await run({
      planFile: await reviewPlan(risk),
      injection: {
        codex: stub,
        agentEnv: {
          ...stubEnv(),
          STUB_WRITE_PATH: 'src/review-probe.js',
          STUB_WRITE_CONTENT: content,
        },
      },
      onEvent: (event) => void events.push(event),
    });

    expect(report.status).toBe(status);
    expect(report.category).toBe(category);
    const review = JSON.parse(
      await readFile(join(artifacts, 'review', 'review.json'), 'utf8'),
    ) as { risk: string; verdict: string };
    expect(review.risk).toBe(risk);
    expect(review.verdict).toBe(status === 'succeeded' ? 'pass' : 'blocked');
    if (status === 'failed') {
      expect(report.commit).toBeUndefined();
      expect(events.map((event) => event.kind)).not.toContain('candidate');
      expect(report.message).toMatch(/opt\.enactment\.rules\..+src\/review-probe\.js/);
    }
  }, 900_000);
});
