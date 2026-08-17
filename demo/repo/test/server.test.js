/* global fetch */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from '../src/server.js';
import { tasks } from '../src/tasks.js';

const server = createServer();
let baseUrl;

beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no TCP address');
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

describe('task board server', () => {
  it('reports health', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('lists seeded tasks', async () => {
    const response = await fetch(`${baseUrl}/api/tasks`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(tasks);
  });

  it('returns 404 for an unknown route', async () => {
    const response = await fetch(`${baseUrl}/missing`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'not_found' });
  });
});
