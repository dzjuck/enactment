import type { CodeBehaviorStep } from '../../plan/schema.js';
import { DISPUTE_PATH } from '../../verify/dispute.js';

export function testWritingPrompt(step: CodeBehaviorStep): string {
  return [
    'Write tests for this behavior. Do not implement it.',
    '',
    step.observable_behavior,
    '',
    'Write only these test paths:',
    ...step.test_paths.map((path) => `- ${path}`),
    '',
    'The tests must use these exact test IDs.',
    'Each ID is the complete Vitest fullName (ancestor describe titles plus the test title).',
    'Use each complete ID as a top-level it()/test() title when possible.',
    'describe() titles become prefixes; if you use them, shorten the nested test title so the fullName remains exact.',
    ...step.expected_test_ids.map((id) => `- ${id}`),
  ].join('\n');
}

export function implementationPrompt(step: CodeBehaviorStep): string {
  return [
    'Implement the behavior described below. The tests are frozen; do not change them.',
    '',
    step.observable_behavior,
    '',
    'Write only these implementation paths:',
    ...step.implementation_paths.map((path) => `- ${path}`),
    '',
    'If the tests are wrong, do not edit them. Write the reason here and stop:',
    `- ${DISPUTE_PATH}`,
  ].join('\n');
}
