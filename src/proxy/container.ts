import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { execa } from 'execa';

import { CODEX_PROVIDER_ALLOWLIST } from '../config/pins.js';
import type { RuntimeImages } from '../docker/images.js';
import { containerLogs, startContainer, stopContainer } from '../docker/run.js';
import { withOwnedResource } from '../run/ownership.js';
import { attemptLabels } from '../volume/naming.js';
import { DEFAULT_PORTS } from './allowlist.js';
import type { ProxyRecord } from './record.js';
import { DEFAULT_PROXY_PORT } from './server.js';

export class ProxyContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyContainerError';
  }
}

export interface ProxyHandle {
  name: string;
  /** Resolvable by container name on the agent's network. */
  host: string;
  port: number;
  records(): Promise<ProxyRecord[]>;
}

export interface ProxyContainerOptions {
  attempt: string;
  /** Internal network the agent lives on. */
  egressNetwork: string;
  /** Outward leg; only the proxy is attached to both. */
  outwardNetwork: string;
  images: RuntimeImages;
  allowlist?: readonly string[];
  ports?: readonly number[];
  /** Injectable startup steps, so each half of the ownership window is testable. */
  connect?: (network: string, container: string) => Promise<void>;
  waitReady?: (container: string) => Promise<void>;
  stop?: (container: string) => Promise<void>;
}

export function proxyEnvironment(handle: ProxyHandle): Record<string, string> {
  const url = `http://${handle.host}:${handle.port}`;

  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
  };
}

/** What `src/proxy/main.ts` prints once it is accepting connections. */
export const PROXY_READY_MARKER = 'proxy listening';

export const PROXY_READY_TIMEOUT_SECONDS = 30;

/**
 * Wait for the proxy to announce itself, attached to its log stream.
 *
 * The earlier shape polled `containerLogs` up to 100 times at 50 ms. Each poll spawned a whole
 * `docker logs` process, so the real interval was several times the nominal one, and the cost
 * was paid twice per tests-first step — once per agent phase. Following the stream costs one
 * process for the whole wait, and notices the marker the moment it is written.
 *
 * The marker is matched against everything received so far rather than per chunk, because a
 * stream boundary can fall inside it.
 */
export async function waitUntilListening(
  name: string,
  timeoutSeconds: number = PROXY_READY_TIMEOUT_SECONDS,
): Promise<void> {
  const child = execa('docker', ['logs', '--follow', name], { reject: false, buffer: false });

  return new Promise<void>((resolve, reject) => {
    let seen = '';
    let settled = false;
    let ended = 0;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.kill();
      if (error === undefined) resolve();
      else reject(error);
    };

    const deadline = setTimeout(() => {
      finish(
        new ProxyContainerError(
          `proxy container ${name} did not start listening within ${String(timeoutSeconds)}s`,
        ),
      );
    }, timeoutSeconds * 1000);

    const consume = (chunk: Buffer | string): void => {
      seen += String(chunk);
      if (seen.includes(PROXY_READY_MARKER)) finish();
    };

    // Both streams: the marker is on stderr today, and a wait that only ever watched one of
    // them would turn a harmless logging change into a 30-second hang.
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', consume);
      stream?.on('end', () => {
        ended += 1;
        // Both streams closed without the marker: the container is gone, and waiting out the
        // deadline would only delay a failure that has already happened.
        if (ended === 2) {
          finish(
            new ProxyContainerError(
              `proxy container ${name} exited without reporting that it was listening`,
            ),
          );
        }
      });
      stream?.on('error', (error: Error) => finish(error));
    }
  });
}

async function connectNetwork(network: string, container: string): Promise<void> {
  await execa('docker', ['network', 'connect', network, container]);
}

/**
 * Start the proxy and hand back a handle only once it is fully usable.
 *
 * Between `startContainer()` and the returned handle the container exists but nobody else
 * knows about it: `withProxy()`'s teardown has not been entered, and an attempt-label sweep
 * would be the only thing left to notice it. That window is owned here, so a failure to
 * attach the outward leg or to reach readiness removes the container before the error
 * escapes.
 */
export async function startProxyContainer(options: ProxyContainerOptions): Promise<ProxyHandle> {
  const name = `enactment-proxy-${options.attempt}`;
  const hosts = options.allowlist ?? CODEX_PROVIDER_ALLOWLIST;
  const ports = options.ports ?? DEFAULT_PORTS;

  const connect = options.connect ?? connectNetwork;
  const waitReady = options.waitReady ?? waitUntilListening;
  const stop = options.stop ?? stopContainer;

  await startContainer({
    image: options.images.proxy.id,
    argv: ['node', '/app/main.js'],
    network: options.egressNetwork,
    name,
    workdir: '/app',
    labels: attemptLabels(options.attempt, 'proxy'),
    env: {
      PROXY_PORT: String(DEFAULT_PROXY_PORT),
      PROXY_ALLOWED_HOSTS: hosts.join(','),
      PROXY_ALLOWED_PORTS: ports.join(','),
    },
  });

  // Owned from here until the handle is returned.
  return withOwnedResource(name, stop, async () => {
    // The outward leg is the proxy's alone: this is what the agent cannot reach directly.
    await connect(options.outwardNetwork, name);
    await waitReady(name);

    return {
      name,
      host: name,
      port: DEFAULT_PROXY_PORT,
      records: async () => {
        const logs = await containerLogs(name);
        return logs.stdout
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as ProxyRecord);
      },
    };
  });
}

/** Run a phase with the proxy up, tearing the container down on every path. */
export async function withProxy<T>(
  options: ProxyContainerOptions,
  run: (handle: ProxyHandle) => Promise<T>,
): Promise<T> {
  const handle = await startProxyContainer(options);

  try {
    return await run(handle);
  } finally {
    await stopContainer(handle.name);
  }
}

export const PROXY_RECORDS_FILE = 'proxy-records.jsonl';

export async function writeProxyRecords(handle: ProxyHandle, artifactDir: string): Promise<string> {
  const records = await handle.records();
  const path = join(artifactDir, PROXY_RECORDS_FILE);

  await mkdir(artifactDir, { recursive: true });
  await writeFile(path, records.map((record) => `${JSON.stringify(record)}\n`).join(''));

  return path;
}
