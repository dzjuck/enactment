import type { CodeBehaviorTask } from '../../task/schema.js';

export function testWritingPrompt(task: CodeBehaviorTask): string {
  return [
    'Write tests for this behavior. Do not implement it.',
    '',
    task.prompt,
    '',
    'Write only these test paths:',
    ...task.test_paths.map((path) => `- ${path}`),
    '',
    'The tests must use these exact test IDs:',
    ...task.expected_test_ids.map((id) => `- ${id}`),
  ].join('\n');
}

export function implementationPrompt(task: CodeBehaviorTask): string {
  return [
    'Implement the behavior described below. The tests are frozen; do not change them.',
    '',
    task.prompt,
    '',
    'Write only these implementation paths:',
    ...task.implementation_paths.map((path) => `- ${path}`),
  ].join('\n');
}
