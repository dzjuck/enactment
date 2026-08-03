import { basename } from 'node:path';

import picomatch from 'picomatch';
import { z } from 'zod';

// DESIGN.md §5 / §36.
export const DEFAULT_TIMEOUTS = {
  connectivity_smoke_seconds: 60,
  setup_seconds: 600,
  agent_seconds: 1200,
  termination_grace_seconds: 10,
};

// DESIGN.md §13: writable agent scopes cannot include manifests or lockfiles.
const DEPENDENCY_MANIFESTS = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
];

export const DEFAULT_VERIFICATION_CLOSURE = [
  ...DEPENDENCY_MANIFESTS,
  'vitest.config.*',
  'jest.config.*',
  'tsconfig*.json',
  'test/setup.*',
];

export const RED_CATEGORIES = [
  'assertion_failure',
  'missing_implementation',
  'expected_type_failure',
] as const;

function coversDependencyManifest(pattern: string): boolean {
  if (DEPENDENCY_MANIFESTS.includes(basename(pattern))) return true;

  const matches = picomatch(pattern, { dot: true });
  return DEPENDENCY_MANIFESTS.some((manifest) => matches(manifest));
}

function repositoryPath(label: string, allowDependencyManifest = false) {
  return z
    .string()
    .min(1, 'must not be empty')
    .superRefine((value, ctx) => {
      if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) {
        ctx.addIssue({
          code: 'custom',
          message: `"${value}" is an absolute path; ${label} are repository-relative`,
        });
      }

      if (value.split(/[\\/]/).includes('..')) {
        ctx.addIssue({
          code: 'custom',
          message: `"${value}" traverses out of the repository with ".."`,
        });
      }

      if (!allowDependencyManifest && coversDependencyManifest(value)) {
        ctx.addIssue({
          code: 'custom',
          message: `"${value}" covers a dependency manifest or lockfile; dependency changes go through the approval flow, not the agent`,
        });
      }
    });
}

const implementationPath = repositoryPath('implementation paths');
const testPath = repositoryPath('test paths');

// DESIGN.md §16: commands are fixed argument arrays, never shell strings.
const command = z.array(z.string().min(1), {
  error: 'must be an argument array, not a shell string',
}).min(1, 'must contain at least the program name');

const timeouts = z
  .strictObject({
    connectivity_smoke_seconds: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_TIMEOUTS.connectivity_smoke_seconds),
    setup_seconds: z.number().int().positive().default(DEFAULT_TIMEOUTS.setup_seconds),
    agent_seconds: z.number().int().positive().default(DEFAULT_TIMEOUTS.agent_seconds),
    termination_grace_seconds: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_TIMEOUTS.termination_grace_seconds),
  })
  .default(DEFAULT_TIMEOUTS);

const commonFields = {
  id: z.string().min(1),
  prompt: z.string().min(1),
  implementation_paths: z.array(implementationPath).min(1, 'must declare at least one path'),
  timeouts,
};

const task = z.strictObject({
  type: z.literal('task'),
  ...commonFields,
  verification: z.strictObject({
    commands: z.array(command).min(1, 'must declare at least one command'),
  }),
});

const codeBehaviorTask = z
  .strictObject({
    type: z.literal('code_behavior'),
    ...commonFields,
    test_paths: z.array(testPath).min(1, 'must declare at least one path'),
    expected_test_ids: z.array(z.string().min(1)).min(1, 'must declare at least one test ID'),
    allowed_red_categories: z.array(z.enum(RED_CATEGORIES)).default([...RED_CATEGORIES]),
    verification: z.strictObject({
      commands: z.array(command).min(1, 'must declare at least one command'),
      test_command: command,
      closure_paths: z
        .array(repositoryPath('closure paths', true))
        .default(DEFAULT_VERIFICATION_CLOSURE),
    }),
    baseline: z
      .strictObject({
        retry_failures: z.number().int().nonnegative().default(1),
        known_flaky_tests: z.array(z.string().min(1)).default([]),
      })
      .default({ retry_failures: 1, known_flaky_tests: [] }),
  })
  .superRefine((value, ctx) => {
    for (const [testIndex, testPattern] of value.test_paths.entries()) {
      const overlaps = value.implementation_paths.some(
        (implementationPattern) =>
          picomatch(implementationPattern, { dot: true })(testPattern) ||
          picomatch(testPattern, { dot: true })(implementationPattern),
      );

      if (overlaps) {
        ctx.addIssue({
          code: 'custom',
          path: ['test_paths', testIndex],
          message: 'test_paths must not overlap implementation_paths',
        });
      }
    }
  });

// Zod dispatches a discriminated union before member defaults run, so inject the M1
// discriminator before parsing old task files that omit it.
export const taskSchema = z.preprocess(
  (input) =>
    typeof input === 'object' && input !== null && !Array.isArray(input) && !('type' in input)
      ? { ...input, type: 'task' }
      : input,
  z.discriminatedUnion('type', [task, codeBehaviorTask]),
);

export type Task = z.infer<typeof taskSchema>;
export type CodeBehaviorTask = Extract<Task, { type: 'code_behavior' }>;
