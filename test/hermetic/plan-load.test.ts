import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PlanConfigError, loadPlan } from '../../src/plan/load.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../fixtures/plan/${name}`, import.meta.url));

async function loadError(name: string): Promise<PlanConfigError> {
  try {
    await loadPlan(fixture(name));
  } catch (error) {
    expect(error).toBeInstanceOf(PlanConfigError);
    return error as PlanConfigError;
  }
  throw new Error(`expected ${name} to be rejected, but it loaded`);
}

describe('loadPlan', () => {
  it('loads an ordered plan of task and code_behavior steps with M2 defaults', async () => {
    const { plan } = await loadPlan(fixture('valid.yml'));

    expect(plan).toEqual({
      version: 1,
      id: 'slugify-plan',
      steps: [
        {
          type: 'task',
          id: 'add-slugify',
          observable_behavior:
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
        },
        {
          type: 'code_behavior',
          id: 'add-slugify-tests-first',
          observable_behavior: 'Add slugify behavior.\n',
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
          baseline: { retry_failures: 1, known_flaky_tests: [] },
          timeouts: {
            connectivity_smoke_seconds: 60,
            setup_seconds: 600,
            agent_seconds: 1200,
            termination_grace_seconds: 10,
          },
        },
      ],
      final_verification: {
        commands: [['npx', '--no-install', 'vitest', 'run']],
      },
    });
  });

  it('hashes the raw file bytes, identically across loads and differently after any change', async () => {
    const first = await loadPlan(fixture('valid.yml'));
    const second = await loadPlan(fixture('valid.yml'));

    expect(first.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.hash).toBe(first.hash);

    const dir = await mkdtemp(join(tmpdir(), 'harness-plan-'));
    const copy = join(dir, 'plan.yml');
    const original = await readFile(fixture('valid.yml'));

    await writeFile(copy, original);
    expect((await loadPlan(copy)).hash).toBe(first.hash);

    await writeFile(copy, Buffer.concat([original, Buffer.from('\n')]));
    expect((await loadPlan(copy)).hash).not.toBe(first.hash);
  });

  describe('plan structure', () => {
    it('rejects duplicate step IDs, naming the offending step', async () => {
      const error = await loadError('duplicate-step-ids.yml');
      expect(error.message).toContain('steps[1].id');
      expect(error.message).toContain('add-slugify');
      expect(error.message).toMatch(/duplicate/i);
    });

    it.each([
      ['invalid-plan-id.yml', 'id', 'Slugify Plan'],
      ['invalid-step-id.yml', 'steps[0].id', '../escape'],
    ])('rejects the non-slug ID in %s', async (name, path, offending) => {
      const error = await loadError(name);
      expect(error.message).toContain(path);
      expect(error.message).toContain(offending);
    });

    it('rejects an empty step list', async () => {
      const error = await loadError('empty-steps.yml');
      expect(error.message).toContain('steps');
      expect(error.message).toMatch(/at least one step/i);
    });

    it('rejects an unknown plan-level field', async () => {
      const error = await loadError('plan-unknown-field.yml');
      expect(error.message).toContain('routing');
    });

    it('rejects an unknown step-level field', async () => {
      const error = await loadError('step-unknown-field.yml');
      expect(error.message).toContain('steps[0]');
      expect(error.message).toContain('test_paths');
    });

    it('rejects the old standalone task document, naming what is missing and unknown', async () => {
      const error = await loadError('standalone-task.yml');
      expect(error.message).toContain('steps');
      expect(error.message).toContain('prompt');
    });
  });

  describe('unsupported milestone surface', () => {
    it.each([
      ['operational-step.yml', 'operational'],
      ['mixed-step.yml', 'mixed'],
    ])('rejects the %s step type explicitly', async (name, type) => {
      const error = await loadError(name);
      expect(error.message).toContain('steps[0].type');
      expect(error.message).toContain(type);
      expect(error.message).toMatch(/not supported/i);
    });

    it('rejects a later-milestone step field rather than storing it inert', async () => {
      const error = await loadError('step-services.yml');
      expect(error.message).toContain('services');
    });
  });

  describe('final_verification', () => {
    it('requires the section', async () => {
      const error = await loadError('missing-final-verification.yml');
      expect(error.message).toContain('final_verification');
    });

    it.each([
      ['empty-final-verification.yml', 'final_verification.commands'],
      ['final-verification-empty-argv.yml', 'final_verification.commands[0]'],
      ['final-verification-command-as-string.yml', 'final_verification.commands[0]'],
    ])('rejects %s', async (name, path) => {
      const error = await loadError(name);
      expect(error.message).toContain(path);
    });
  });

  describe('step contract validation, applied at the step path', () => {
    it.each([
      ['code-behavior-missing-test-paths.yml', 'steps[0].test_paths'],
      ['code-behavior-missing-expected-test-ids.yml', 'steps[0].expected_test_ids'],
      ['code-behavior-missing-test-command.yml', 'steps[0].verification.test_command'],
      ['code-behavior-empty-expected-test-ids.yml', 'steps[0].expected_test_ids'],
      ['code-behavior-invalid-red-category.yml', 'steps[0].allowed_red_categories'],
      ['missing-id.yml', 'steps[0].id'],
      ['missing-observable-behavior.yml', 'steps[0].observable_behavior'],
      ['missing-implementation-paths.yml', 'steps[0].implementation_paths'],
      ['empty-implementation-paths.yml', 'steps[0].implementation_paths'],
      ['missing-verification-commands.yml', 'steps[0].verification.commands'],
      ['command-as-string.yml', 'steps[0].verification.commands[0]'],
    ])('rejects %s at %s', async (name, path) => {
      const error = await loadError(name);
      expect(error.message).toContain(path);
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

    it.each([
      ['absolute-path.yml', '/etc/passwd', /absolute/i],
      ['traversal-path.yml', 'src/../../outside/slugify.js', /\.\./],
      ['dependency-manifest-path.yml', 'package.json', /dependenc/i],
      ['lockfile-path.yml', 'package-lock.json', /dependenc/i],
      ['glob-covering-manifest.yml', '**', /dependenc/i],
    ])('applies repository path rules to implementation paths in %s', async (name, offending, message) => {
      const error = await loadError(name);
      expect(error.message).toContain(offending);
      expect(error.message).toMatch(message);
    });

    it('applies timeout defaults when the step omits them', async () => {
      const { plan } = await loadPlan(fixture('no-timeouts.yml'));

      expect(plan.steps[0]?.timeouts).toEqual({
        connectivity_smoke_seconds: 60,
        setup_seconds: 600,
        agent_seconds: 1200,
        termination_grace_seconds: 10,
      });
    });

    it('defaults code_behavior verification.commands to none, since test_command is the verification', async () => {
      const { plan } = await loadPlan(
        fileURLToPath(new URL('../../fixtures/m2-repo/plan.yml', import.meta.url)),
      );

      expect(plan.steps[0]?.verification.commands).toEqual([]);
    });
  });
});
