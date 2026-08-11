import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROXY_READY_MARKER,
  ProxyContainerError,
  waitUntilListening,
} from '../../src/proxy/container.js';

interface FakeChild {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => void;
}

const { calls, children, killed, fakeExeca } = vi.hoisted(() => {
  const recorded: string[][] = [];
  const spawned: { stdout: PassThrough; stderr: PassThrough; kill: () => void }[] = [];
  const wasKilled: boolean[] = [];

  const fake = (_file: string, args: string[]): unknown => {
    recorded.push(args);
    const index = spawned.length;
    wasKilled.push(false);

    const child = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        wasKilled[index] = true;
      },
    };
    spawned.push(child);

    // execa's return value is promise-like; nothing here awaits it, but it must not reject.
    return Object.assign(Promise.resolve({ exitCode: 0 }), child);
  };

  return { calls: recorded, children: spawned, killed: wasKilled, fakeExeca: fake };
});

vi.mock('execa', () => ({ execa: fakeExeca }));

beforeEach(() => {
  calls.length = 0;
  children.length = 0;
  killed.length = 0;
});

/** The spawned child, once the implementation has had a turn to create it. */
async function child(): Promise<FakeChild> {
  for (let attempt = 0; attempt < 50 && children.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const spawned = children[0];
  if (spawned === undefined) throw new Error('no docker logs process was started');
  return spawned;
}

describe('waitUntilListening', () => {
  it('attaches to the log stream once instead of polling', async () => {
    const pending = waitUntilListening('enactment-proxy-a1');
    const stream = await child();

    stream.stderr.write(`${PROXY_READY_MARKER} on 3128 for chatgpt.com\n`);
    await expect(pending).resolves.toBeUndefined();

    // One process for the whole wait — the point of the change.
    expect(calls).toEqual([['logs', '--follow', 'enactment-proxy-a1']]);
    expect(killed[0]).toBe(true);
  });

  it('waits through unrelated output rather than giving up on the first line', async () => {
    const pending = waitUntilListening('enactment-proxy-a1');
    const stream = await child();

    stream.stderr.write('starting up\n');
    stream.stderr.write('reading allowlist\n');
    let settled = false;
    void pending.then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    stream.stderr.write(`${PROXY_READY_MARKER} on 3128\n`);
    await expect(pending).resolves.toBeUndefined();
  });

  it('finds a marker split across two chunks', async () => {
    const pending = waitUntilListening('enactment-proxy-a1');
    const stream = await child();

    const half = Math.floor(PROXY_READY_MARKER.length / 2);
    stream.stderr.write(PROXY_READY_MARKER.slice(0, half));
    stream.stderr.write(`${PROXY_READY_MARKER.slice(half)} on 3128\n`);

    await expect(pending).resolves.toBeUndefined();
  });

  it('accepts the marker on stdout as well as stderr', async () => {
    const pending = waitUntilListening('enactment-proxy-a1');
    const stream = await child();

    stream.stdout.write(`${PROXY_READY_MARKER} on 3128\n`);
    await expect(pending).resolves.toBeUndefined();
  });

  it('fails loudly when the stream ends without the marker', async () => {
    const pending = waitUntilListening('enactment-proxy-a1');
    const stream = await child();

    stream.stderr.end();
    stream.stdout.end();

    await expect(pending).rejects.toThrow(ProxyContainerError);
    await expect(pending).rejects.toThrow(/enactment-proxy-a1/);
  });

  it('fails loudly on its deadline, and kills the attached process', async () => {
    const pending = waitUntilListening('enactment-proxy-a1', 0.05);
    await child();

    await expect(pending).rejects.toThrow(ProxyContainerError);
    expect(killed[0]).toBe(true);
  });
});
