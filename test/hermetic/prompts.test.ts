import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { testWritingPrompt } from '../../src/adapters/codex/prompts.js';
import { loadTask } from '../../src/task/load.js';

describe('tests-first prompts', () => {
  it('explains that expected IDs are complete Vitest full names', async () => {
    const taskFile = fileURLToPath(
      new URL('../../fixtures/m2-repo/task.yml', import.meta.url),
    );
    const { task } = await loadTask(taskFile);

    if (task.type !== 'code_behavior') throw new Error('expected code_behavior fixture');

    const prompt = testWritingPrompt(task);

    expect(prompt).toContain('Each ID is the complete Vitest fullName');
    expect(prompt).toContain('Use each complete ID as a top-level it()/test() title');
    expect(prompt).toContain('describe() titles become prefixes');
  });
});
