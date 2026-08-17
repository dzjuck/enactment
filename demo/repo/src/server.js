/* global process */

import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { tasks } from './tasks.js';

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(value)}\n`);
}

export function createServer() {
  return createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'GET' && request.url === '/api/tasks') {
      sendJson(response, 200, tasks);
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  createServer().listen(port, host, () => {
    process.stdout.write(`task-board listening on ${host}:${String(port)}\n`);
  });
}
