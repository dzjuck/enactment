import { expect, it } from 'vitest';

import { summarize } from '../src/summary.js';

it('summarize counts every task', () => {
  const tasks = [
    { status: 'todo' },
    { status: 'doing' },
    { status: 'done' },
  ];

  expect(summarize(tasks).total).toBe(3);
});

it('summarize groups tasks by status', () => {
  const tasks = [
    { status: 'todo' },
    { status: 'todo' },
    { status: 'doing' },
    { status: 'done' },
    { status: 'done' },
  ];

  expect(summarize(tasks).byStatus).toEqual({ todo: 2, doing: 1, done: 2 });
});

it('summarize reports zero for a status with no tasks', () => {
  expect(summarize([{ status: 'done' }]).byStatus).toEqual({ todo: 0, doing: 0, done: 1 });
});
