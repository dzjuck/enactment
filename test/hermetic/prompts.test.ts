import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { implementationPrompt, testWritingPrompt } from '../../src/adapters/codex/prompts.js';
import { loadPlan } from '../../src/plan/load.js';

const planFile = fileURLToPath(new URL('../../fixtures/m2-repo/plan.yml', import.meta.url));

async function codeBehaviorStep() {
  const { plan } = await loadPlan(planFile);
  const step = plan.steps[0];

  if (step?.type !== 'code_behavior') throw new Error('expected code_behavior fixture');
  return step;
}

describe('tests-first prompts', () => {
  it('explains that expected IDs are complete Vitest full names', async () => {
    const prompt = testWritingPrompt(await codeBehaviorStep());

    expect(prompt).toContain('Each ID is the complete Vitest fullName');
    expect(prompt).toContain('Use each complete ID as a top-level it()/test() title');
    expect(prompt).toContain('describe() titles become prefixes');
  });

  it('sends the step\'s observable_behavior to both agent phases', async () => {
    const step = await codeBehaviorStep();

    expect(testWritingPrompt(step)).toContain(step.observable_behavior);
    expect(implementationPrompt(step)).toContain(step.observable_behavior);
  });
});
