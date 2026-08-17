import { access, readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPlan } from '../../src/plan/load.js';

const DEMO = join(process.cwd(), 'demo');
const REPO = join(DEMO, 'repo');

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('demo assets', () => {
  it('loads the published two-step plan with its declared routing inputs', async () => {
    const { plan } = await loadPlan(join(DEMO, 'plan.yml'));

    expect(
      plan.steps.map((step) => ({
        id: step.id,
        type: step.type,
        complexity: step.complexity,
        risk: step.risk,
      })),
    ).toEqual([
      {
        id: 'summarize-tasks',
        type: 'code_behavior',
        complexity: 'low',
        risk: 'standard',
      },
      {
        id: 'summary-endpoint',
        type: 'task',
        complexity: 'medium',
        risk: 'standard',
      },
    ]);
  });

  it('starts without step 1 paths and with the step 2 server path', async () => {
    const { plan } = await loadPlan(join(DEMO, 'plan.yml'));
    const first = plan.steps[0];
    const second = plan.steps[1];
    if (first?.type !== 'code_behavior' || second?.type !== 'task') {
      throw new Error('expected code_behavior followed by task');
    }

    await expect(
      Promise.all(
        [...first.implementation_paths, ...first.test_paths].map((path) =>
          exists(join(REPO, path)),
        ),
      ),
    ).resolves.toEqual([false, false]);
    await expect(
      Promise.all(second.implementation_paths.map((path) => exists(join(REPO, path)))),
    ).resolves.toEqual([true]);
  });

  it('names an existing runtime check and keeps the lockfile outside every step scope', async () => {
    const { plan } = await loadPlan(join(DEMO, 'plan.yml'));
    const second = plan.steps[1];
    if (second?.type !== 'task' || second.verification.runtime === undefined) {
      throw new Error('expected task runtime verification');
    }

    const behavioral = second.verification.runtime.behavioral_commands[0]?.[1];
    expect(behavioral).toBe('check/summary.mjs');
    await expect(exists(join(REPO, behavioral ?? ''))).resolves.toBe(true);
    await expect(exists(join(REPO, 'package-lock.json'))).resolves.toBe(true);

    const scopedPaths = plan.steps.flatMap((step) => [
      ...step.implementation_paths,
      ...(step.type === 'code_behavior' ? step.test_paths : []),
    ]);
    expect(scopedPaths).not.toContain('package-lock.json');
  });

  it('makes the recorded RED test import step 1 implementation', async () => {
    const { plan } = await loadPlan(join(DEMO, 'plan.yml'));
    const first = plan.steps[0];
    if (first?.type !== 'code_behavior') throw new Error('expected code_behavior first');

    const answerPath = join(DEMO, 'answers', first.test_paths[0] ?? '');
    const source = await readFile(answerPath, 'utf8');
    const specifier = /from\s+['"](\.[^'"]+)['"]/.exec(source)?.[1];
    if (specifier === undefined) throw new Error('recorded test has no static import');

    const resolved = normalize(join(dirname(first.test_paths[0] ?? ''), specifier));
    expect(resolved).toBe(first.implementation_paths[0]);
  });

  it('records every expected test ID as a test title', async () => {
    const { plan } = await loadPlan(join(DEMO, 'plan.yml'));
    const first = plan.steps[0];
    if (first?.type !== 'code_behavior') throw new Error('expected code_behavior first');

    const source = await readFile(join(DEMO, 'answers', first.test_paths[0] ?? ''), 'utf8');
    for (const id of first.expected_test_ids) {
      expect(source).toMatch(new RegExp(`(?:it|test)\\(['"]${id}['"]`));
    }
  });
});
