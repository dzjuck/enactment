import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TaskConfigError, loadTask } from '../../src/task/load.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../fixtures/task/${name}`, import.meta.url));

async function loadError(name: string): Promise<TaskConfigError> {
  try {
    await loadTask(fixture(name));
  } catch (error) {
    expect(error).toBeInstanceOf(TaskConfigError);
    return error as TaskConfigError;
  }
  throw new Error(`expected ${name} to be rejected, but it loaded`);
}

describe('loadTask', () => {
  it('loads a valid task.yml into the expected typed object', async () => {
    const { task } = await loadTask(fixture('valid.yml'));

    expect(task).toEqual({
      type: 'task',
      id: 'add-slugify',
      prompt:
        'Implement the slugify function in src/slugify.js so that it converts a title\ninto a URL-safe slug.\n',
      implementation_paths: ['src/slugify.js', 'src/util/**'],
      verification: {
        commands: [['npx', '--no-install', 'vitest', 'run', '--config', 'vitest.config.js']],
      },
      timeouts: {
        connectivity_smoke_seconds: 30,
        setup_seconds: 300,
        agent_seconds: 600,
        termination_grace_seconds: 5,
      },
    });
  });

  it('loads a valid code_behavior task with contract defaults', async () => {
    const { task } = await loadTask(fixture('code-behavior.yml'));

    expect(task).toEqual({
      type: 'code_behavior',
      id: 'add-slugify-tests-first',
      prompt: 'Add slugify behavior.\n',
      implementation_paths: ['src/slugify.js'],
      test_paths: ['test/slugify.test.js'],
      expected_test_ids: ['slugify lowercases and hyphenates'],
      allowed_red_categories: ['assertion_failure', 'missing_implementation'],
      verification: {
        commands: [['npm', 'run', 'typecheck']],
        test_command: ['npx', '--no-install', 'vitest', 'run'],
        closure_paths: [
          'package.json',
          'package-lock.json',
          'npm-shrinkwrap.json',
          'yarn.lock',
          'pnpm-lock.yaml',
          'bun.lockb',
          'vitest.config.*',
          'jest.config.*',
          'tsconfig*.json',
          'test/setup.*',
        ],
      },
      baseline: {
        retry_failures: 1,
        known_flaky_tests: [],
      },
      timeouts: {
        connectivity_smoke_seconds: 60,
        setup_seconds: 600,
        agent_seconds: 1200,
        termination_grace_seconds: 10,
      },
    });
  });

  it('defaults verification.commands to none, since test_command is the verification', async () => {
    const { task } = await loadTask(
      fileURLToPath(new URL('../../fixtures/m2-repo/task.yml', import.meta.url)),
    );

    expect(task.verification.commands).toEqual([]);
  });

  it.each([
    ['code-behavior-missing-test-paths.yml', 'test_paths'],
    ['code-behavior-missing-expected-test-ids.yml', 'expected_test_ids'],
    ['code-behavior-missing-test-command.yml', 'verification.test_command'],
  ])('rejects %s, naming the missing contract field', async (name, field) => {
    const error = await loadError(name);
    expect(error.message).toContain(field);
  });

  it('rejects overlapping test and implementation paths', async () => {
    const error = await loadError('code-behavior-overlapping-paths.yml');
    expect(error.message).toMatch(/test_paths.*implementation_paths|overlap/i);
  });

  it.each([
    ['code-behavior-absolute-test-path.yml', /absolute/i],
    ['code-behavior-traversal-test-path.yml', /\.\./],
    ['code-behavior-manifest-test-path.yml', /dependenc/i],
  ])('applies repository path rules to test paths in %s', async (name, message) => {
    const error = await loadError(name);
    expect(error.message).toContain('test_paths');
    expect(error.message).toMatch(message);
  });

  it('rejects empty expected_test_ids', async () => {
    const error = await loadError('code-behavior-empty-expected-test-ids.yml');
    expect(error.message).toContain('expected_test_ids');
  });

  it('rejects an unknown RED category', async () => {
    const error = await loadError('code-behavior-invalid-red-category.yml');
    expect(error.message).toContain('allowed_red_categories');
  });

  it.each([
    ['missing-id.yml', 'id'],
    ['missing-prompt.yml', 'prompt'],
    ['missing-implementation-paths.yml', 'implementation_paths'],
    ['missing-verification-commands.yml', 'verification.commands'],
  ])('rejects %s, naming the missing field', async (name, field) => {
    const error = await loadError(name);
    expect(error.message).toContain(field);
  });

  it('rejects an unknown top-level field', async () => {
    const error = await loadError('unknown-field.yml');
    expect(error.message).toContain('test_paths');
  });

  it('rejects a verification command given as a string rather than an array', async () => {
    const error = await loadError('command-as-string.yml');
    expect(error.message).toContain('verification.commands[0]');
  });

  it('rejects an absolute implementation path', async () => {
    const error = await loadError('absolute-path.yml');
    expect(error.message).toContain('/etc/passwd');
    expect(error.message).toMatch(/absolute/i);
  });

  it('rejects an implementation path containing a .. traversal', async () => {
    const error = await loadError('traversal-path.yml');
    expect(error.message).toContain('src/../../outside/slugify.js');
    expect(error.message).toMatch(/\.\./);
  });

  it.each([
    ['dependency-manifest-path.yml', 'package.json'],
    ['lockfile-path.yml', 'package-lock.json'],
    ['glob-covering-manifest.yml', '**'],
  ])('rejects %s as a declared dependency-manifest change', async (name, offending) => {
    const error = await loadError(name);
    expect(error.message).toContain(offending);
    expect(error.message).toMatch(/dependenc/i);
  });

  it('rejects empty implementation_paths', async () => {
    const error = await loadError('empty-implementation-paths.yml');
    expect(error.message).toContain('implementation_paths');
  });

  it('applies timeout defaults when the section is absent', async () => {
    const { task } = await loadTask(fixture('no-timeouts.yml'));

    expect(task.timeouts).toEqual({
      connectivity_smoke_seconds: 60,
      setup_seconds: 600,
      agent_seconds: 1200,
      termination_grace_seconds: 10,
    });
  });

  it('hashes identically across loads and differently after any byte change', async () => {
    const first = await loadTask(fixture('valid.yml'));
    const second = await loadTask(fixture('valid.yml'));

    expect(first.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.hash).toBe(first.hash);

    const dir = await mkdtemp(join(tmpdir(), 'harness-task-'));
    const copy = join(dir, 'task.yml');
    const original = await readFile(fixture('valid.yml'));

    await writeFile(copy, original);
    expect((await loadTask(copy)).hash).toBe(first.hash);

    await writeFile(copy, Buffer.concat([original, Buffer.from('\n')]));
    expect((await loadTask(copy)).hash).not.toBe(first.hash);
  });
});
