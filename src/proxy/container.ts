import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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

async function waitUntilListening(name: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = await containerLogs(name);
    if (logs.stderr.includes('proxy listening')) return;
    await delay(50);
  }

  throw new ProxyContainerError(`proxy container ${name} did not start listening`);
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
  const name = `ai-harness-proxy-${options.attempt}`;
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
