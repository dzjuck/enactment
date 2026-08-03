import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadPlan } from '../../src/plan/load.js';
import { singlePlanStep } from '../../src/run/bridge.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../fixtures/plan/${name}`, import.meta.url));

describe('single-step plan bridge', () => {
  it('returns the only step of a one-step plan', async () => {
    const { plan } = await loadPlan(fixture('single-step.yml'));

    expect(singlePlanStep(plan).id).toBe('add-slugify');
  });

  it('rejects a multi-step plan rather than silently running only the first step', async () => {
    const { plan } = await loadPlan(fixture('valid.yml'));

    expect(() => singlePlanStep(plan)).toThrow(/2 steps/);
  });
});
