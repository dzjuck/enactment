import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as allowlistModule from '../../src/proxy/allowlist.js';
import { AllowlistError, createAllowlist } from '../../src/proxy/allowlist.js';
import * as recordModule from '../../src/proxy/record.js';
import type { ProxyRecord } from '../../src/proxy/record.js';
import * as serverModule from '../../src/proxy/server.js';
import { startProxy, type ProxyServer } from '../../src/proxy/server.js';
import {
  connectThroughProxy,
  sendRaw,
  startOrigin,
  websocketAccept,
  type OriginServer,
} from '../helpers/proxy-client.js';

let origin: OriginServer;
let proxy: ProxyServer;
let records: ProxyRecord[];

async function startWith(hosts: string[], ports: number[]): Promise<void> {
  // The sink is captured rather than read from the module binding when a record arrives. A
  // connection a previous test left pending emits after this one has started, and would
  // otherwise be pushed into this test's array.
  const sink: ProxyRecord[] = [];
  records = sink;
  proxy = await startProxy({
    allowlist: createAllowlist({ hosts, ports }),
    onRecord: (record) => sink.push(record),
  });
}

/** Wait for the record the proxy emits when a connection finishes. */
async function nextRecord(): Promise<ProxyRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = records[0];
    if (record !== undefined) return record;
    await delay(10);
  }
  throw new Error('no proxy record was emitted');
}

afterEach(async () => {
  await proxy?.close();
  await origin?.close();
});

describe('CONNECT proxy', () => {
  beforeEach(async () => {
    origin = await startOrigin((socket) => {
      socket.on('data', (chunk: Buffer) => {
        if (chunk.toString() === 'ping') socket.write('pong!');
      });
    });
  });

  it('control: tunnels bytes in both directions to an allowlisted origin', async () => {
    await startWith(['127.0.0.1'], [origin.port]);

    const { socket, statusLine } = await connectThroughProxy(
      proxy.port,
      `127.0.0.1:${origin.port}`,
    );
    socket.write('ping');
    const [echoed] = (await once(socket, 'data')) as [Buffer];
    socket.end();

    expect(statusLine).toContain('200');
    expect(echoed.toString()).toBe('pong!');
  });

  it('refuses a non-allowlisted host with 403 and opens no socket to it', async () => {
    await startWith(['chatgpt.com'], [origin.port]);

    const { statusLine } = await connectThroughProxy(proxy.port, `127.0.0.1:${origin.port}`);

    expect(statusLine).toContain('403');
    expect(origin.connections).toBe(0);
  });

  it('emits exactly the §7 record fields', async () => {
    await startWith(['127.0.0.1'], [origin.port]);

    const { socket } = await connectThroughProxy(proxy.port, `127.0.0.1:${origin.port}`);
    socket.write('ping');
    await once(socket, 'data');
    socket.end();

    const record = await nextRecord();
    expect(Object.keys(record).sort()).toEqual(
      ['allowed', 'bytesFromOrigin', 'bytesToOrigin', 'durationMs', 'hostname', 'port', 'result'].sort(),
    );
    expect(record.hostname).toBe('127.0.0.1');
    expect(record.allowed).toBe(true);
    expect(record.result).toBe('tunneled');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('counts the bytes actually transferred, in both directions', async () => {
    await startWith(['127.0.0.1'], [origin.port]);

    const { socket } = await connectThroughProxy(proxy.port, `127.0.0.1:${origin.port}`);
    socket.write('ping');
    await once(socket, 'data');
    socket.end();

    const record = await nextRecord();
    expect(record.bytesToOrigin).toBe(4);
    expect(record.bytesFromOrigin).toBe(5);
  });

  it('matches hosts exactly, never by substring', async () => {
    const allowlist = createAllowlist({ hosts: ['openai.com'], ports: [443] });

    expect(allowlist.allows('openai.com', 443)).toBe(true);
    expect(allowlist.allows('evil-openai.com', 443)).toBe(false);
    expect(allowlist.allows('openai.com.attacker.test', 443)).toBe(false);
    expect(allowlist.allows('openai.co', 443)).toBe(false);
  });

  it('never implies subdomains', async () => {
    const allowlist = createAllowlist({ hosts: ['chatgpt.com'], ports: [443] });

    expect(allowlist.allows('chatgpt.com', 443)).toBe(true);
    expect(allowlist.allows('ab.chatgpt.com', 443)).toBe(false);
  });

  it('rejects wildcard syntax as a configuration error', () => {
    expect(() => createAllowlist({ hosts: ['*.example.com'] })).toThrow(AllowlistError);
    expect(() => createAllowlist({ hosts: ['*'] })).toThrow(AllowlistError);
  });

  it('checks the port as well as the host', async () => {
    await startWith(['127.0.0.1'], [443]);

    const { statusLine } = await connectThroughProxy(proxy.port, `127.0.0.1:${origin.port}`);

    expect(statusLine).toContain('403');
    expect(origin.connections).toBe(0);
  });

  it('refuses non-CONNECT verbs: this is not a forward proxy', async () => {
    await startWith(['127.0.0.1'], [origin.port]);

    const response = await sendRaw(
      proxy.port,
      'GET http://127.0.0.1/secret HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
    );

    expect(response).toContain('405');
  });

  it('refuses a malformed request line without dying', async () => {
    await startWith(['127.0.0.1'], [origin.port]);

    await sendRaw(proxy.port, 'this is not http at all\r\n\r\n');

    // Still serving: the control request succeeds afterwards.
    const { statusLine } = await connectThroughProxy(proxy.port, `127.0.0.1:${origin.port}`);
    expect(statusLine).toContain('200');
  });

  it('records an allowlisted host that fails to resolve as an error', async () => {
    await startWith(['nonexistent.invalid'], [443]);

    await connectThroughProxy(proxy.port, 'nonexistent.invalid:443');

    const record = await nextRecord();
    expect(record.allowed).toBe(true);
    expect(record.result).toBe('error');
  });

  it('still records a connection the client abandons mid-tunnel', async () => {
    await startWith(['127.0.0.1'], [origin.port]);

    const { socket } = await connectThroughProxy(proxy.port, `127.0.0.1:${origin.port}`);
    socket.write('ping');
    socket.destroy();

    const record = await nextRecord();
    expect(record.hostname).toBe('127.0.0.1');
    expect(record.result).toBe('tunneled');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records no request path and no payload bytes: the proxy is L4', async () => {
    await startWith(['127.0.0.1'], [origin.port]);

    const { socket } = await connectThroughProxy(proxy.port, `127.0.0.1:${origin.port}`);
    socket.write('ping');
    await once(socket, 'data');
    socket.end();

    const serialized = JSON.stringify(await nextRecord());
    expect(serialized).not.toContain('ping');
    expect(serialized).not.toContain('pong');
    expect(serialized).not.toContain('/secret');
  });

  it('tunnels a WebSocket upgrade end to end and counts both directions', async () => {
    await origin.close();
    origin = await startOrigin((socket) => {
      socket.once('data', (chunk: Buffer) => {
        const key = /sec-websocket-key: (.+)\r\n/i.exec(chunk.toString())?.[1] ?? '';
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${websocketAccept(key.trim())}\r\n\r\n`,
        );
        socket.on('data', (frame: Buffer) => socket.write(frame));
      });
    });
    await startWith(['127.0.0.1'], [origin.port]);

    const { socket } = await connectThroughProxy(proxy.port, `127.0.0.1:${origin.port}`);
    const upgrade =
      'GET /backend-api/codex/responses HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';

    socket.write(upgrade);
    const [handshake] = (await once(socket, 'data')) as [Buffer];

    socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    const [frame] = (await once(socket, 'data')) as [Buffer];
    socket.end();

    const record = await nextRecord();
    expect(handshake.toString()).toContain('101 Switching Protocols');
    expect(handshake.toString()).toContain(websocketAccept('dGhlIHNhbXBsZSBub25jZQ=='));
    expect(frame).toEqual(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    expect(record.bytesToOrigin).toBe(upgrade.length + 4);
    expect(record.bytesFromOrigin).toBeGreaterThan(4);
  });

  it('exposes no TLS interception or CA injection surface', async () => {
    const surface = [
      ...Object.keys(allowlistModule),
      ...Object.keys(recordModule),
      ...Object.keys(serverModule),
    ];

    expect(surface.filter((name) => /tls|ssl|cert|ca[A-Z_]|intercept|mitm|decrypt/i.test(name))).toEqual(
      [],
    );

    origin = await startOrigin(() => {});
    await startWith(['127.0.0.1'], [origin.port]);
    const { socket } = await connectThroughProxy(proxy.port, `127.0.0.1:${origin.port}`);
    socket.end();

    const record = await nextRecord();
    expect(Object.keys(record)).not.toContain('body');
    expect(Object.keys(record)).not.toContain('path');
  });
});
