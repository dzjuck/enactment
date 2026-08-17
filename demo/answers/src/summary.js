export function summarize(tasks) {
  const byStatus = { todo: 0, doing: 0, done: 0 };

  for (const task of tasks) {
    byStatus[task.status] += 1;
  }

  return { total: tasks.length, byStatus };
}
