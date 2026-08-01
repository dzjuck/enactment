import { connect, createServer, type Server, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

export interface TunnelHandle {
  socket: Socket;
  statusLine: string;
}

/** Speak the CONNECT half of the proxy protocol by hand, so nothing is abstracted away. */
export async function connectThroughProxy(
  proxyPort: number,
  target: string,
): Promise<TunnelHandle> {
  const socket = connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');

  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);

  let buffered = '';
  for (;;) {
    const [chunk] = (await once(socket, 'data')) as [Buffer];
    buffered += chunk.toString('latin1');
    if (buffered.includes('\r\n\r\n')) break;
  }

  return { socket, statusLine: buffered.split('\r\n')[0] ?? '' };
}

export async function sendRaw(proxyPort: number, request: string): Promise<string> {
  const socket = connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(request);

  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  await once(socket, 'close');

  return Buffer.concat(chunks).toString('utf8');
}

export interface OriginServer {
  port: number;
  connections: number;
  close: () => Promise<void>;
}

/** A TCP origin the tests can point the proxy at, with a per-connection behavior. */
export async function startOrigin(onConnection: (socket: Socket) => void): Promise<OriginServer> {
  const state = { connections: 0 };

  const server: Server = createServer((socket) => {
    state.connections += 1;
    onConnection(socket);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    get connections() {
      return state.connections;
    },
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function websocketAccept(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}
