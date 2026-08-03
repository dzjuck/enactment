import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';
import type { $ZodIssue } from 'zod/v4/core';

import { planSchema, type Plan } from './schema.js';

export class PlanConfigError extends Error {
  readonly filePath: string;

  constructor(message: string, filePath: string) {
    super(message);
    this.name = 'PlanConfigError';
    this.filePath = filePath;
  }
}

export interface LoadedPlan {
  plan: Plan;
  /** sha256 of the file bytes: the plan's approval identity, so any byte change is a new plan. */
  hash: string;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    return acc === '' ? String(segment) : `${acc}.${String(segment)}`;
  }, '');
}

function formatIssue(issue: $ZodIssue): string {
  const label = formatPath(issue.path);
  return label === '' ? issue.message : `${label}: ${issue.message}`;
}

export async function loadPlan(filePath: string): Promise<LoadedPlan> {
  const bytes = await readFile(filePath);
  const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

  let document: unknown;
  try {
    document = parse(bytes.toString('utf8'), { uniqueKeys: true });
  } catch (error) {
    throw new PlanConfigError(
      `${filePath} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    );
  }

  const result = planSchema.safeParse(document);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `  - ${formatIssue(issue)}`).join('\n');
    throw new PlanConfigError(`Invalid plan file ${filePath}:\n${details}`, filePath);
  }

  return { plan: result.data, hash };
}
