/* global fetch, process */

import { tasks } from '../src/tasks.js';

const appUrl = process.env.ENACTMENT_APP_URL;
if (appUrl === undefined) throw new Error('ENACTMENT_APP_URL is required');

const expected = {
  total: tasks.length,
  byStatus: { todo: 0, doing: 0, done: 0 },
};

for (const task of tasks) {
  expected.byStatus[task.status] += 1;
}

const response = await fetch(`${appUrl}/api/tasks/summary`);
if (!response.ok) {
  throw new Error(`GET /api/tasks/summary returned ${String(response.status)}`);
}

const actual = await response.json();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(
    `summary mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

process.stdout.write('summary endpoint matches seeded tasks\n');
