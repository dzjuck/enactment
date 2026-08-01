import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';

import type { Allowlist } from './allowlist.js';
import type { ConnectionResult, RecordWriter } from './record.js';

export interface ProxyOptions {
  allowlist: Allowlist;
  onRecord: RecordWriter;
  host?: string;
  port?: number;
}

export interface ProxyServer {
  port: number;
  close(): Promise<void>;
}

export const DEFAULT_PROXY_PORT = 3128;

function parseTarget(target: string): { hostname: string; port: number } | undefined {
  const match = /^(?<hostname>.+):(?<port>\d{1,5})$/.exec(target);
  const hostname = match?.groups?.hostname;
  const port = Number(match?.groups?.port);

  if (hostname === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }

  return { hostname, port };
}

/**
 * A CONNECT-only proxy with an exact-hostname allowlist (DESIGN.md §7).
 *
 * It never terminates TLS and never inspects anything above layer 4: after the tunnel is
 * established it moves bytes and counts them. That is a permanent property, not a default —
 * Codex talks over a WebSocket, so there is no request/response structure left to inspect.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyServer> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((_request, response) => {
    // Not a forward proxy: only CONNECT is served, and the connection is not kept alive.
    response.writeHead(405, { allow: 'CONNECT', connection: 'close' });
    response.end();
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
  });

  server.on('connect', (request, clientSocket: Socket, head: Buffer) => {
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));

    const startedAt = Date.now();
    const target = parseTarget(request.url ?? '');

    if (target === undefined) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    const { hostname, port } = target;
    let bytesToOrigin = 0;
    let bytesFromOrigin = 0;
    let recorded = false;

    const record = (result: ConnectionResult, allowed: boolean): void => {
      if (recorded) return;
      recorded = true;
      options.onRecord({
        hostname,
        port,
        allowed,
        result,
        bytesToOrigin,
        bytesFromOrigin,
        durationMs: Date.now() - startedAt,
      });
    };

    if (!options.allowlist.allows(hostname, port)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      record('denied', false);
      return;
    }

    const upstream = connect(port, hostname);
    sockets.add(upstream);
    let established = false;

    upstream.on('connect', () => {
      established = true;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      if (head.length > 0) {
        bytesToOrigin += head.length;
        upstream.write(head);
      }

      clientSocket.on('data', (chunk: Buffer) => (bytesToOrigin += chunk.length));
      upstream.on('data', (chunk: Buffer) => (bytesFromOrigin += chunk.length));

      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

    upstream.on('error', () => {
      if (!established && clientSocket.writable) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      clientSocket.destroy();
      record('error', true);
    });

    upstream.on('close', () => {
      sockets.delete(upstream);
      record('tunneled', true);
    });

    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => upstream.destroy());
  });

  server.listen(options.port ?? 0, options.host ?? '0.0.0.0');
  await once(server, 'listening');

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
