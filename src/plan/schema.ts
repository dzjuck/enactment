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

// Only the categories the RED classifier can actually conclude. DESIGN.md §23 also lists
// `expected_type_failure`; it is left out until something produces it.
export const RED_CATEGORIES = ['assertion_failure', 'missing_implementation'] as const;

/** M3 executes `task` and `code_behavior`. DESIGN.md §21's other types wait for their milestone. */
export const STEP_TYPES = ['task', 'code_behavior'] as const;
export const STEP_COMPLEXITIES = ['low', 'medium', 'high'] as const;
export type StepComplexity = (typeof STEP_COMPLEXITIES)[number];

const LATER_MILESTONE_TYPES = ['operational', 'mixed'];

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

/** Plan and step IDs name a Git branch and an artifact directory, so they stay boring. */
const slug = z.string().refine((value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value), {
  error: (issue) =>
    `"${String(issue.input)}" is not a lowercase slug (a-z, 0-9, single hyphens); IDs name a Git branch and an artifact directory`,
});

const implementationPath = repositoryPath('implementation paths');
const testPath = repositoryPath('test paths');

// DESIGN.md §16: commands are fixed argument arrays, never shell strings.
const command = z
  .array(z.string().min(1), { error: 'must be an argument array, not a shell string' })
  .min(1, 'must contain at least the program name');

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
  id: slug,
  complexity: z.enum(STEP_COMPLEXITIES),
  observable_behavior: z.string().min(1),
  implementation_paths: z.array(implementationPath).min(1, 'must declare at least one path'),
  timeouts,
};

const taskStep = z.strictObject({
  type: z.literal('task'),
  ...commonFields,
  verification: z.strictObject({
    commands: z.array(command).min(1, 'must declare at least one command'),
  }),
});

const codeBehaviorStep = z
  .strictObject({
    type: z.literal('code_behavior'),
    ...commonFields,
    test_paths: z.array(testPath).min(1, 'must declare at least one path'),
    expected_test_ids: z.array(z.string().min(1)).min(1, 'must declare at least one test ID'),
    allowed_red_categories: z.array(z.enum(RED_CATEGORIES)).default([...RED_CATEGORIES]),
    verification: z.strictObject({
      // Optional here, unlike `type: task`: `test_command` is already a verification, and
      // repeating it under `commands` runs the same suite a fourth time.
      commands: z.array(command).default([]),
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

// The type is validated on its own before the union dispatches, so an unsupported step type
// is reported at `steps[n].type` with its own name in the message rather than as an opaque
// "no matching variant" on the whole step.
const stepType = z.enum(STEP_TYPES, {
  error: (issue) =>
    typeof issue.input === 'string' && LATER_MILESTONE_TYPES.includes(issue.input)
      ? `step type "${issue.input}" is not supported yet; M3 runs "task" and "code_behavior"`
      : `must be one of: ${STEP_TYPES.join(', ')}`,
});

const step = z
  .looseObject({ type: stepType })
  .pipe(z.discriminatedUnion('type', [taskStep, codeBehaviorStep]));

export const planSchema = z
  .strictObject({
    version: z.literal(1),
    id: slug,
    // Position is the dependency chain: step N depends on step N-1. M3 runs one step at a
    // time, so nothing more than an order is needed.
    steps: z.array(step).min(1, 'must declare at least one step'),
    final_verification: z.strictObject({
      commands: z.array(command).min(1, 'must declare at least one command'),
    }),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();

    for (const [index, planStep] of value.steps.entries()) {
      if (seen.has(planStep.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'id'],
          message: `duplicate step ID "${planStep.id}"`,
        });
      }
      seen.add(planStep.id);
    }
  });

export type Plan = z.infer<typeof planSchema>;
export type PlanStep = Plan['steps'][number];
export type CodeBehaviorStep = Extract<PlanStep, { type: 'code_behavior' }>;
