import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import type { RuntimeImage } from '../../src/docker/images.js';
import type { RunInjection } from '../../src/run/inject.js';
import { runTask, type RunPhase, type RunReport } from '../../src/run/orchestrator.js';
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
  await writeFile(join(source, AUTH_FILE), JSON.stringify({ tokens: { access_token: 'm2-canary' } }));

  taskFile = await writeTask(join(root, 'task.yml'));
}, 900_000);

async function writeTask(path: string, knownFlakyTests: string[] = []): Promise<string> {
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
      '    - ["npx", "--no-install", "vitest", "run", "--globals"]',
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
      expect(report.failedPhase).toBe('verify');
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
