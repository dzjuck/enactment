import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import type { RuntimeImage } from '../../src/docker/images.js';
import type { RunInjection } from '../../src/run/inject.js';
import {
  runTask,
  RUN_PHASES,
  type RunPhase,
  type RunReport,
} from '../../src/run/orchestrator.js';
import { commitAll, createM2Repo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

const TEST_SOURCE = `import { slugify } from '../src/slugify.js';

describe('slugify', () => {
  it('lowercases and hyphenates words', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });
});
`;

const IMPLEMENTATION_SOURCE = `export function slugify(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
`;

const DISPUTE_PATH = '.harness/test-contract-dispute.md';
const CANARY = 'm2-canary';
const ATTEMPT_LABEL = 'ai-harness.attempt';

let repo: TargetRepo;
let root: string;
let taskFile: string;
let stub: RuntimeImage;
const dirs: string[] = [];

function phaseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    STUB_MODE_TESTS: 'write',
    STUB_EVENTS_TESTS: cannedEvents(),
    STUB_WRITE_PATH_TESTS: 'test/slugify.test.js',
    STUB_WRITE_CONTENT_TESTS: TEST_SOURCE,
    STUB_MODE_IMPLEMENTATION: 'write',
    STUB_EVENTS_IMPLEMENTATION: cannedEvents(),
    STUB_WRITE_PATH_IMPLEMENTATION: 'src/slugify.js',
    STUB_WRITE_CONTENT_IMPLEMENTATION: IMPLEMENTATION_SOURCE,
    ...overrides,
  };
}

beforeAll(async () => {
  stub = await stubAgentImage();
  repo = await createM2Repo();
  root = await mkdtemp(join(tmpdir(), 'harness-m2-'));

  const source = join(root, 'codex-source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, AUTH_FILE), JSON.stringify({ tokens: { access_token: CANARY } }));

  taskFile = await writeTask(join(root, 'task.yml'));
}, 900_000);

async function writeTask(
  path: string,
  knownFlakyTests: string[] = [],
  verificationCommands: string[][] = [
    ['npx', '--no-install', 'vitest', 'run', '--globals'],
  ],
): Promise<string> {
  await writeFile(
    path,
    [
      'type: code_behavior',
      'id: add-slugify-tests-first',
      'prompt: Add slugify behavior for URL-safe titles.',
      'implementation_paths:',
      '  - src/slugify.js',
      'test_paths:',
      '  - test/slugify.test.js',
      'expected_test_ids:',
      '  - slugify lowercases and hyphenates words',
      'verification:',
      '  test_command: ["npx", "--no-install", "vitest", "run", "--globals"]',
      '  commands:',
      ...verificationCommands.map((command) => `    - ${JSON.stringify(command)}`),
      ...(knownFlakyTests.length === 0
        ? []
        : [
            'baseline:',
            '  known_flaky_tests:',
            ...knownFlakyTests.map((id) => `    - ${id}`),
          ]),
      'timeouts:',
      '  connectivity_smoke_seconds: 20',
      '  agent_seconds: 6',
      '  termination_grace_seconds: 2',
      '',
    ].join('\n'),
  );
  return path;
}

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function run(
  env: Record<string, string> = phaseEnv(),
  overrides: Partial<Parameters<typeof runTask>[0]> = {},
): Promise<{ report: RunReport; artifacts: string }> {
  const artifacts = await mkdtemp(join(tmpdir(), 'harness-m2-artifacts-'));
  dirs.push(artifacts);
  const injection: RunInjection = { agent: stub, agentEnv: env };

  const report = await runTask({
    taskFile,
    repoPath: repo.dir,
    artifactDir: artifacts,
    sourceCodexHome: join(root, 'codex-source'),
    storeDirectory: join(root, 'store'),
    dependencyCacheDirectory: join(root, 'deps'),
    injection,
    ...overrides,
  });

  return { report, artifacts };
}

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

async function labelledResources(
  kind: 'container' | 'volume' | 'network',
  attempt: string,
): Promise<string[]> {
  const filter = `label=${ATTEMPT_LABEL}=${attempt}`;
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', filter]
      : [kind, 'ls', '-q', '--filter', filter];
  const { stdout } = await execa('docker', args);
  return stdout.split('\n').filter((line) => line !== '');
}

async function expectNoResources(attempt: string): Promise<void> {
  await expect(labelledResources('container', attempt)).resolves.toEqual([]);
  await expect(labelledResources('volume', attempt)).resolves.toEqual([]);
  await expect(labelledResources('network', attempt)).resolves.toEqual([]);
}

describe('code_behavior pipeline', () => {
  it('materializes a clean repository whose existing suite passes', async () => {
    await expect(access(join(repo.dir, 'src/slugify.js'))).rejects.toThrow();
    await expect(access(join(repo.dir, 'test/slugify.test.js'))).rejects.toThrow();
    expect(await git(repo.dir, ['rev-parse', 'HEAD'])).toBe(repo.commit);

    const vitest = join(process.cwd(), 'node_modules/vitest/vitest.mjs');
    const baseline = await execa('node', [vitest, 'run', '--globals', 'test/existing.test.js'], {
      cwd: repo.dir,
      reject: false,
    });
    expect(baseline.exitCode).toBe(0);
  }, 300_000);

  it('runs two scoped agents and commits both phases with separate artifacts', async () => {
    const { report, artifacts } = await run();

    expect(report.status).toBe('succeeded');
    const changed = await git(repo.dir, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      report.commit ?? '',
    ]);
    expect(changed.split('\n')).toEqual(['src/slugify.js', 'test/slugify.test.js']);

    const testsPrompt = await readFile(join(artifacts, 'tests/prompt.txt'), 'utf8');
    const implementationPrompt = await readFile(
      join(artifacts, 'implementation/prompt.txt'),
      'utf8',
    );
    expect(testsPrompt).toContain('Add slugify behavior for URL-safe titles.');
    expect(testsPrompt).toContain('test/slugify.test.js');
    expect(testsPrompt).toContain('slugify lowercases and hyphenates words');
    expect(implementationPrompt).toContain('src/slugify.js');
    expect(implementationPrompt).not.toBe(testsPrompt);
    await expect(access(join(artifacts, 'tests/agent-events.jsonl'))).resolves.toBeUndefined();
    await expect(
      access(join(artifacts, 'implementation/agent-events.jsonl')),
    ).resolves.toBeUndefined();
  }, 900_000);

  it('captures the clean pre-agent baseline and stores every existing test', async () => {
    const seen: RunPhase[] = [];
    const { report, artifacts } = await run(phaseEnv(), {
      onPhase: (phase) => void seen.push(phase),
    });

    expect(report.status).toBe('succeeded');
    expect(seen.indexOf('baseline')).toBeLessThan(seen.indexOf('tests'));

    const baseline = JSON.parse(
      await readFile(join(artifacts, 'baseline/baseline.json'), 'utf8'),
    ) as { tests: { id: string; status: string }[] };
    expect(baseline.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'existing behavior already passes', status: 'passed' }),
        expect.objectContaining({
          id: 'baseline verifier is offline and has no provider auth',
          status: 'passed',
        }),
      ]),
    );
  }, 900_000);

  it('blocks a genuine baseline failure before starting an agent', async () => {
    const brokenRepo = await createM2Repo();
    const seen: RunPhase[] = [];
    try {
      await writeFile(
        join(brokenRepo.dir, 'test/broken.test.js'),
        "it('genuine baseline failure', () => { expect(true).toBe(false); });\n",
      );
      brokenRepo.commit = await commitAll(brokenRepo.dir, 'Add broken baseline test');

      const { report, artifacts } = await run(phaseEnv(), {
        repoPath: brokenRepo.dir,
        onPhase: (phase) => void seen.push(phase),
      });

      expect(report.status).toBe('failed');
      expect(report.failedPhase).toBe('baseline');
      expect(report.category).toBe('baseline_failed');
      expect(report.message).toContain('genuine baseline failure');
      expect(seen).not.toContain('tests');
      await expect(access(join(artifacts, 'tests/prompt.txt'))).rejects.toThrow();
    } finally {
      await removeRepo(brokenRepo.dir);
    }
  }, 900_000);

  it('continues past an approved quarantine and records it', async () => {
    const flakyRepo = await createM2Repo();
    const flakyId = 'baseline-only quarantine';
    try {
      await writeFile(
        join(flakyRepo.dir, 'test/flaky.test.js'),
        [
          `it('${flakyId}', () => {`,
          '  expect(true).toBe(false);',
          '});',
          '',
        ].join('\n'),
      );
      flakyRepo.commit = await commitAll(flakyRepo.dir, 'Add quarantined baseline test');
      const flakyTask = await writeTask(join(root, 'task-flaky.yml'), [flakyId]);

      const { report, artifacts } = await run(phaseEnv(), {
        repoPath: flakyRepo.dir,
        taskFile: flakyTask,
      });

      expect(report.status).toBe('failed');
      expect(report.failedPhase).toBe('green');
      const manifest = JSON.parse(
        await readFile(join(artifacts, 'run-manifest.json'), 'utf8'),
      ) as { baseline: { quarantined: string[] } };
      expect(manifest.baseline.quarantined).toEqual([flakyId]);
      await expect(access(join(artifacts, 'tests/prompt.txt'))).resolves.toBeUndefined();
    } finally {
      await removeRepo(flakyRepo.dir);
    }
  }, 900_000);

  it('blocks when an expected test ID already exists at baseline', async () => {
    const completedRepo = await createM2Repo();
    try {
      await writeFile(
        join(completedRepo.dir, 'test/slugify.test.js'),
        [
          "describe('slugify', () => {",
          "  it('lowercases and hyphenates words', () => { expect(true).toBe(true); });",
          '});',
          '',
        ].join('\n'),
      );
      completedRepo.commit = await commitAll(completedRepo.dir, 'Add completed expected test');

      const { report } = await run(phaseEnv(), { repoPath: completedRepo.dir });

      expect(report.status).toBe('failed');
      expect(report.category).toBe('baseline_failed');
      expect(report.message).toContain('slugify lowercases and hyphenates words');
    } finally {
      await removeRepo(completedRepo.dir);
    }
  }, 900_000);

  it('records valid missing_implementation RED before implementation', async () => {
    const seen: RunPhase[] = [];
    const { report, artifacts } = await run(phaseEnv(), {
      onPhase: (phase) => void seen.push(phase),
    });

    expect(report.status).toBe('succeeded');
    expect(seen.indexOf('red')).toBeLessThan(seen.indexOf('implementation'));
    const verdict = JSON.parse(
      await readFile(join(artifacts, 'red/verdict.json'), 'utf8'),
    ) as { valid: boolean; category: string };
    const results = JSON.parse(
      await readFile(join(artifacts, 'red/results.json'), 'utf8'),
    ) as { suiteFailures: { cause: string; specifier?: string }[] };
    expect(verdict).toMatchObject({ valid: true, category: 'missing_implementation' });
    expect(results.suiteFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cause: 'missing_module',
          specifier: '../src/slugify.js',
        }),
      ]),
    );
  }, 900_000);

  it('blocks invalid RED before implementation and commits nothing', async () => {
    const before = await git(repo.dir, ['rev-list', '--all', '--count']);
    const { report, artifacts } = await run(
      phaseEnv({
        STUB_WRITE_CONTENT_TESTS:
          "import 'missing-red-package';\ndescribe('slugify', () => { it('unreachable', () => {}); });\n",
      }),
    );

    expect(report.status).toBe('failed');
    expect(report.failedPhase).toBe('red');
    expect(report.category).toBe('red_invalid');
    expect(report.message).toContain('unrelated_missing_dependency');
    expect(report.commit).toBeUndefined();
    expect(await git(repo.dir, ['rev-list', '--all', '--count'])).toBe(before);
    await expect(access(join(artifacts, 'implementation/prompt.txt'))).rejects.toThrow();

    const verdict = JSON.parse(
      await readFile(join(artifacts, 'red/verdict.json'), 'utf8'),
    ) as { valid: boolean; reasons: { category: string }[] };
    expect(verdict.valid).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'unrelated_missing_dependency' }),
      ]),
    );
  }, 900_000);

  it('reaches GREEN and commits a correct implementation', async () => {
    const seen: RunPhase[] = [];
    const { report, artifacts } = await run(phaseEnv(), {
      onPhase: (phase) => void seen.push(phase),
    });

    expect(report.status).toBe('succeeded');
    expect(report.commit).toBeDefined();
    expect(seen.indexOf('green')).toBeLessThan(seen.indexOf('verify'));
    const verdict = JSON.parse(
      await readFile(join(artifacts, 'green/verdict.json'), 'utf8'),
    ) as { valid: boolean };
    expect(verdict.valid).toBe(true);
  }, 900_000);

  it('fails GREEN and names the failing expected test in its artifact', async () => {
    const { report, artifacts } = await run(
      phaseEnv({
        STUB_WRITE_CONTENT_IMPLEMENTATION:
          'export function slugify(title) { return String(title); }\n',
      }),
    );

    expect(report.status).toBe('failed');
    expect(report.failedPhase).toBe('green');
    expect(report.category).toBe('verification_failed');
    expect(report.commit).toBeUndefined();
    const results = JSON.parse(
      await readFile(join(artifacts, 'green/results.json'), 'utf8'),
    ) as { tests: { id: string; status: string }[] };
    expect(results.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'slugify lowercases and hyphenates words',
          status: 'failed',
        }),
      ]),
    );
  }, 900_000);

  it('still runs opaque verification commands after GREEN', async () => {
    const opaqueFailureTask = await writeTask(
      join(root, 'task-opaque-failure.yml'),
      [],
      [['node', '-e', 'process.exit(7)']],
    );
    const { report, artifacts } = await run(phaseEnv(), { taskFile: opaqueFailureTask });

    expect(report.status).toBe('failed');
    expect(report.failedPhase).toBe('verify');
    expect(report.category).toBe('verification_failed');
    const verdict = JSON.parse(
      await readFile(join(artifacts, 'green/verdict.json'), 'utf8'),
    ) as { valid: boolean };
    expect(verdict.valid).toBe(true);
  }, 900_000);

  it('accepts the implementation snapshot, not verifier mutations', async () => {
    const mutateVerifierTask = await writeTask(
      join(root, 'task-verifier-mutation.yml'),
      [],
      [[
        'node',
        '-e',
        "require('node:fs').writeFileSync('src/slugify.js', 'export const tampered = true;\\n')",
      ]],
    );
    const { report } = await run(phaseEnv(), { taskFile: mutateVerifierTask });

    expect(report.status).toBe('succeeded');
    expect(await git(repo.dir, ['show', `${report.commit ?? ''}:src/slugify.js`])).toBe(
      IMPLEMENTATION_SOURCE.trimEnd(),
    );
  }, 900_000);

  it('records a test-contract dispute and stops without a commit', async () => {
    const reason = 'The expected slug format contradicts the requested behavior.';
    const { report, artifacts } = await run(
      phaseEnv({
        STUB_WRITE_PATH_IMPLEMENTATION: DISPUTE_PATH,
        STUB_WRITE_CONTENT_IMPLEMENTATION: reason,
      }),
    );

    expect(report.status).toBe('failed');
    expect(report.category).toBe('test_contract_disputed');
    expect(report.category).not.toBe('verification_failed');
    expect(report.commit).toBeUndefined();
    expect(
      await readFile(join(artifacts, 'implementation/test-contract-dispute.md'), 'utf8'),
    ).toContain(reason);
    expect(
      await readFile(join(artifacts, 'implementation/prompt.txt'), 'utf8'),
    ).toContain(DISPUTE_PATH);
    await expect(access(join(repo.dir, 'test/slugify.test.js'))).rejects.toThrow();
  }, 900_000);

  it('reports closure_violation when a dispute also changes a frozen path', async () => {
    const { report } = await run(
      phaseEnv({
        STUB_WRITE_PATH_IMPLEMENTATION: DISPUTE_PATH,
        STUB_WRITE_CONTENT_IMPLEMENTATION: 'The test is wrong.',
        STUB_SYMLINK_PATH_IMPLEMENTATION: 'test/slugify.test.js',
        STUB_SYMLINK_TARGET_IMPLEMENTATION: '../src/slugify.js',
      }),
    );

    expect(report.status).toBe('failed');
    expect(report.category).toBe('closure_violation');
    expect(report.commit).toBeUndefined();
  }, 900_000);

  it('rejects a phase-two edit to a frozen test file as closure_violation', async () => {
    const before = await git(repo.dir, ['rev-list', '--all', '--count']);
    const { report } = await run(
      phaseEnv({
        STUB_WRITE_PATH_IMPLEMENTATION: 'test/slugify.test.js',
        STUB_WRITE_CONTENT_IMPLEMENTATION: `${TEST_SOURCE}\n// weakened by implementation phase\n`,
      }),
    );

    expect(report.status).toBe('failed');
    expect(report.category).toBe('closure_violation');
    expect(report.message).toContain('test/slugify.test.js');
    expect(report.commit).toBeUndefined();
    expect(await git(repo.dir, ['rev-list', '--all', '--count'])).toBe(before);
  }, 900_000);

  it('rejects a phase-two runner config change as closure_violation', async () => {
    const { report } = await run(
      phaseEnv({
        STUB_WRITE_PATH_IMPLEMENTATION: 'vitest.config.js',
        STUB_WRITE_CONTENT_IMPLEMENTATION: 'export default {};\n',
      }),
    );

    expect(report.status).toBe('failed');
    expect(report.category).toBe('closure_violation');
    expect(report.message).toContain('vitest.config.js');
    expect(report.commit).toBeUndefined();
  }, 900_000);

  it('rejects a phase-one closure change while allowing declared test writes', async () => {
    const { report } = await run(
      phaseEnv({
        STUB_WRITE_PATH_TESTS: 'vitest.config.js',
        STUB_WRITE_CONTENT_TESTS: 'export default {};\n',
      }),
    );

    expect(report.status).toBe('failed');
    expect(report.category).toBe('closure_violation');
    expect(report.message).toContain('vitest.config.js');
    await expect(access(join(repo.dir, 'test/slugify.test.js'))).rejects.toThrow();
  }, 900_000);

  it('records the frozen-set digest in the run manifest', async () => {
    const { report, artifacts } = await run();

    expect(report.status).toBe('succeeded');
    const manifest = JSON.parse(
      await readFile(join(artifacts, 'run-manifest.json'), 'utf8'),
    ) as { frozen: { digest: string } };
    expect(manifest.frozen.digest).toMatch(/^[a-f0-9]{64}$/);
  }, 900_000);

  it('records the complete code-behavior evidence chain with phase-scoped artifacts', async () => {
    const { report, artifacts } = await run();

    expect(report.status).toBe('succeeded');
    expect(RUN_PHASES).toEqual(
      expect.arrayContaining(['baseline', 'tests', 'red', 'implementation', 'green']),
    );
    const manifest = JSON.parse(
      await readFile(join(artifacts, 'run-manifest.json'), 'utf8'),
    ) as {
      baseline: { digest: string; quarantined: string[] };
      frozen: { digest: string };
      red: { valid: boolean; category: string };
      green: { valid: boolean };
      usage: {
        tests: { input_tokens: number };
        implementation: { input_tokens: number };
      };
      snapshots: { pre_agent: string; tests: string; implementation: string };
    };
    expect(manifest.baseline.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.baseline.quarantined).toEqual([]);
    expect(manifest.frozen.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.red).toMatchObject({ valid: true, category: 'missing_implementation' });
    expect(manifest.green.valid).toBe(true);
    expect(manifest.usage.tests.input_tokens).toBeGreaterThan(0);
    expect(manifest.usage.implementation.input_tokens).toBeGreaterThan(0);
    expect(manifest.snapshots.pre_agent).toMatch(/^sha256:/);
    expect(manifest.snapshots.tests).toMatch(/^sha256:/);
    expect(manifest.snapshots.implementation).toMatch(/^sha256:/);

    const files = (await walk(artifacts)).map((path) => path.replace(`${artifacts}/`, ''));
    expect(files).toEqual(
      expect.arrayContaining([
        'baseline/baseline.json',
        'red/results.json',
        'red/verdict.json',
        'green/results.json',
        'green/verdict.json',
        'tests/prompt.txt',
        'tests/agent-events.jsonl',
        'implementation/prompt.txt',
        'implementation/agent-events.jsonl',
        'tests/source-diff.json',
        'implementation/source-diff.json',
      ]),
    );
    for (const file of await walk(artifacts)) {
      expect(await readFile(file, 'utf8')).not.toContain(CANARY);
    }
    await expectNoResources(report.attempt);
  }, 900_000);

  it.each([
    ['baseline', 'baseline_failed'],
    ['tests', 'agent_failed'],
    ['red', 'red_invalid'],
    ['implementation', 'agent_failed'],
    ['green', 'verification_failed'],
  ] as const)(
    'fails cleanly when %s is injected',
    async (injectedPhase, category) => {
      const before = await git(repo.dir, ['rev-list', '--all', '--count']);
      const { report } = await run(phaseEnv(), {
        onPhase: (phase) => {
          if (phase === injectedPhase) throw new Error(`injected ${injectedPhase} failure`);
        },
      });

      expect(report.status).toBe('failed');
      expect(report.failedPhase).toBe(injectedPhase);
      expect(report.category).toBe(category);
      expect(report.commit).toBeUndefined();
      expect(await git(repo.dir, ['rev-list', '--all', '--count'])).toBe(before);
      await expectNoResources(report.attempt);
    },
    900_000,
  );

  it('rejects implementation written during the tests phase', async () => {
    const before = await git(repo.dir, ['rev-list', '--all', '--count']);
    const { report } = await run(
      phaseEnv({ STUB_WRITE_PATH_TESTS: 'src/slugify.js', STUB_WRITE_CONTENT_TESTS: IMPLEMENTATION_SOURCE }),
    );

    expect(report.status).toBe('failed');
    expect(report.category).toBe('invalid_change');
    expect(report.message).toMatch(/tests/i);
    expect(await git(repo.dir, ['rev-list', '--all', '--count'])).toBe(before);
  }, 900_000);

  it('rejects writes outside implementation_paths during implementation', async () => {
    const { report } = await run(
      phaseEnv({ STUB_WRITE_PATH_IMPLEMENTATION: 'README.md', STUB_WRITE_CONTENT_IMPLEMENTATION: 'changed' }),
    );

    expect(report.status).toBe('failed');
    expect(report.category).toBe('invalid_change');
    expect(report.message).toMatch(/implementation/i);
    expect(report.commit).toBeUndefined();
  }, 900_000);

  it('rejects a phase that writes nothing and names it', async () => {
    const { report } = await run(
      phaseEnv({ STUB_MODE_TESTS: 'events', STUB_WRITE_PATH_TESTS: '' }),
    );

    expect(report.status).toBe('failed');
    expect(report.category).toBe('invalid_change');
    expect(report.message).toMatch(/tests/i);
  }, 900_000);

  it('gives phase one its own timeout and never starts phase two after it hangs', async () => {
    const { report, artifacts } = await run(phaseEnv({ STUB_MODE_TESTS: 'hang' }));

    expect(report.status).toBe('failed');
    expect(report.failedPhase).toBe('tests');
    expect(report.category).toBe('agent_timeout');
    await expect(access(join(artifacts, 'implementation/prompt.txt'))).rejects.toThrow();
  }, 900_000);
});
