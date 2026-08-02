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

// DESIGN.md §13: agents cannot persistently modify manifests or lockfiles, so declaring
// them as implementation paths is refused at parse time rather than caught at diff time.
const DEPENDENCY_MANIFESTS = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
];

function coversDependencyManifest(pattern: string): boolean {
  if (DEPENDENCY_MANIFESTS.includes(basename(pattern))) return true;

  const matches = picomatch(pattern, { dot: true });
  return DEPENDENCY_MANIFESTS.some((manifest) => matches(manifest));
}

const implementationPath = z
  .string()
  .min(1, 'must not be empty')
  .superRefine((value, ctx) => {
    if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) {
      ctx.addIssue({
        code: 'custom',
        message: `"${value}" is an absolute path; implementation paths are repository-relative`,
      });
    }

    if (value.split(/[\\/]/).includes('..')) {
      ctx.addIssue({
        code: 'custom',
        message: `"${value}" traverses out of the repository with ".."`,
      });
    }

    if (coversDependencyManifest(value)) {
      ctx.addIssue({
        code: 'custom',
        message: `"${value}" covers a dependency manifest or lockfile; dependency changes go through the approval flow, not the agent`,
      });
    }
  });

// DESIGN.md §16: commands are fixed argument arrays, never shell strings.
const command = z.array(z.string().min(1), {
  error: 'must be an argument array, not a shell string',
}).min(1, 'must contain at least the program name');

// A strict subset of the §19 step schema. Milestone 2 extends it; unknown fields are
// rejected rather than ignored, mirroring Codex `--strict-config`.
export const taskSchema = z.strictObject({
  id: z.string().min(1),
  prompt: z.string().min(1),
  implementation_paths: z.array(implementationPath).min(1, 'must declare at least one path'),
  verification: z.strictObject({
    commands: z.array(command).min(1, 'must declare at least one command'),
  }),
  timeouts: z
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
    .default(DEFAULT_TIMEOUTS),
});

export type Task = z.infer<typeof taskSchema>;
