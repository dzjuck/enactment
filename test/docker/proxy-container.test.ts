import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { IMAGE_PINS } from '../../src/config/pins.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { runContainer, type RunResult } from '../../src/docker/run.js';
import { withPhaseNetworks } from '../../src/net/manage.js';
import { OwnershipError } from '../../src/run/ownership.js';
import {
  proxyEnvironment,
  startProxyContainer,
  withProxy,
  writeProxyRecords,
  type ProxyHandle,
} from '../../src/proxy/container.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { runtimeImages } from '../helpers/images.js';
import { ORIGIN_PORT, startOriginContainer, type OriginContainer } from '../helpers/origin-server.js';

const ALLOWED_ORIGIN = 'ai-harness-origin-allowed';
const DENIED_ORIGIN = 'ai-harness-origin-denied';

let artifactDir: string;
let images: RuntimeImages;
const origins: OriginContainer[] = [];

beforeAll(async () => {
  images = await runtimeImages();
  artifactDir = await mkdtemp(join(tmpdir(), 'harness-proxy-artifacts-'));
});

afterAll(async () => {
  await rm(artifactDir, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(origins.splice(0).map((origin) => origin.stop()));
});

function curlThrough(network: string, env: Record<string, string>, url: string): Promise<RunResult> {
  return runContainer({
    image: IMAGE_PINS.agent.tag,
    argv: ['curl', '-sS', '--proxytunnel', '--max-time', '10', url],
    network,
    env,
  });
}

/** The agent phase, with both origins standing on the far side of the proxy. */
async function inAgentPhase<T>(
  run: (context: {
    handle: ProxyHandle;
    agentNetwork: string;
  }) => Promise<T>,
  allowlist: readonly string[] = [ALLOWED_ORIGIN],
): Promise<T> {
  const attempt = newAttemptId();

  return withPhaseNetworks(attempt, 'agent', async (networks) => {
    const outward = networks['proxy-egress'] ?? '';
    const allowed = await startOriginContainer(ALLOWED_ORIGIN, outward);
    const denied = await startOriginContainer(DENIED_ORIGIN, outward);
    origins.push(allowed, denied);

    try {
      return await withProxy(
        {
          attempt,
          egressNetwork: networks.egress ?? '',
          outwardNetwork: outward,
          allowlist,
          ports: [ORIGIN_PORT],
          images,
        },
        (handle) => run({ handle, agentNetwork: networks.egress ?? '' }),
      );
    } finally {
      // Inside the phase: a container still attached to a network blocks its removal.
      await Promise.all([allowed.stop(), denied.stop()]);
    }
  });
}

describe('proxy container', () => {
  it('control: an agent container reaches an allowlisted origin through the proxy', async () => {
    const result = await inAgentPhase(async ({ handle, agentNetwork }) =>
      curlThrough(
        agentNetwork,
        proxyEnvironment(handle),
        `http://${ALLOWED_ORIGIN}:${ORIGIN_PORT}/`,
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ORIGIN_OK');
  }, 120_000);

  it('cannot reach that same origin without proxy configuration', async () => {
    const result = await inAgentPhase(async ({ agentNetwork }) =>
      curlThrough(agentNetwork, {}, `http://${ALLOWED_ORIGIN}:${ORIGIN_PORT}/`),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('ORIGIN_OK');
  }, 120_000);

  it('refuses a non-allowlisted origin through the proxy', async () => {
    const result = await inAgentPhase(async ({ handle, agentNetwork }) =>
      curlThrough(
        agentNetwork,
        proxyEnvironment(handle),
        `http://${DENIED_ORIGIN}:${ORIGIN_PORT}/`,
      ),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('ORIGIN_OK');
  }, 120_000);

  it('runs the proxy itself non-root and hardened', async () => {
    const inspected = await inAgentPhase(async ({ handle }) => {
      const { stdout } = await execa('docker', [
        'inspect',
        '--format',
        '{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{index .HostConfig.CapDrop 0}}|{{index .HostConfig.SecurityOpt 0}}',
        handle.name,
      ]);
      return stdout.trim();
    });

    expect(inspected).toBe('1001:1001|true|ALL|no-new-privileges');
  }, 120_000);

  it('writes the phase proxy records into the run artifacts', async () => {
    const path = await inAgentPhase(async ({ handle, agentNetwork }) => {
      const env = proxyEnvironment(handle);
      await curlThrough(agentNetwork, env, `http://${ALLOWED_ORIGIN}:${ORIGIN_PORT}/`);
      await curlThrough(agentNetwork, env, `http://${DENIED_ORIGIN}:${ORIGIN_PORT}/`);

      return writeProxyRecords(handle, artifactDir);
    });

    const records = (await readFile(path, 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records.some((r) => r.hostname === ALLOWED_ORIGIN && r.allowed === true)).toBe(true);
    expect(records.some((r) => r.hostname === DENIED_ORIGIN && r.allowed === false)).toBe(true);
    expect(records.every((r) => !('path' in r) && !('body' in r))).toBe(true);
  }, 120_000);

  it('destroys the proxy container when the phase throws', async () => {
    let name = '';

    await expect(
      inAgentPhase(async ({ handle }) => {
        name = handle.name;
        throw new Error('phase exploded');
      }),
    ).rejects.toThrow('phase exploded');

    const { stdout } = await execa('docker', ['ps', '-aq', '--filter', `name=${name}`]);
    expect(stdout.trim()).toBe('');
  }, 120_000);
});

describe('proxy startup is atomic', () => {
  async function containerExists(name: string): Promise<boolean> {
    const { stdout } = await execa('docker', ['ps', '-aq', '--filter', `name=^${name}$`]);
    return stdout.trim() !== '';
  }

  async function networkExists(name: string): Promise<boolean> {
    const { exitCode } = await execa('docker', ['network', 'inspect', name], { reject: false });
    return exitCode === 0;
  }

  /** Start the proxy inside a real agent topology, with one startup step made to fail. */
  async function startWith(
    overrides: Partial<Parameters<typeof startProxyContainer>[0]>,
  ): Promise<{ failure: unknown; name: string; networks: string[] }> {
    const attempt = newAttemptId();
    const name = `ai-harness-proxy-${attempt}`;
    const created: string[] = [];

    const failure = await withPhaseNetworks(attempt, 'agent', (networks) => {
      created.push(...Object.values(networks));

      return startProxyContainer({
        attempt,
        egressNetwork: networks.egress ?? '',
        outwardNetwork: networks['proxy-egress'] ?? '',
        allowlist: [ALLOWED_ORIGIN],
        ports: [ORIGIN_PORT],
        images,
        ...overrides,
      }).catch((cause: unknown) => cause);
    });

    return { failure, name, networks: created };
  }

  it('removes the container when the outward network connect fails', async () => {
    const { failure, name } = await startWith({
      connect: () => Promise.reject(new Error('outward leg refused')),
    });

    expect((failure as Error).message).toContain('outward leg refused');
    await expect(containerExists(name)).resolves.toBe(false);
  }, 120_000);

  it('removes the container when readiness fails after both attachments', async () => {
    const attached: string[] = [];

    const { failure, name } = await startWith({
      connect: async (network) => void attached.push(network),
      waitReady: () => Promise.reject(new Error('never started listening')),
    });

    // The failure must come after the outward leg was attached: this is the window in which
    // a container exists on two networks and nothing else would clean it up.
    expect(attached).toHaveLength(1);
    expect((failure as Error).message).toContain('never started listening');
    await expect(containerExists(name)).resolves.toBe(false);
  }, 120_000);

  it('reports both causes when the container also cannot be removed', async () => {
    const { failure, name, networks } = await startWith({
      connect: () => Promise.reject(new Error('outward leg refused')),
      stop: () => Promise.reject(new Error('daemon refused removal')),
    });

    try {
      expect(failure).toBeInstanceOf(OwnershipError);
      expect((failure as Error).message).toContain('outward leg refused');
      expect((failure as Error).message).toContain('daemon refused removal');

      // The container is still there: that is the point — the harness reported the leak
      // instead of swallowing it. Removing it is this test's job, not the harness's.
      await expect(containerExists(name)).resolves.toBe(true);
    } finally {
      // A network the leaked container is still attached to cannot be removed, and the
      // daemon releases the endpoint asynchronously — so the container goes first and the
      // network removal retries rather than failing silently and leaving a dangling network.
      await execa('docker', ['rm', '--force', name], { reject: false });

      for (const network of networks) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const { exitCode } = await execa('docker', ['network', 'rm', network], { reject: false });
          if (exitCode === 0) break;
          if (!(await networkExists(network))) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        await expect(networkExists(network)).resolves.toBe(false);
      }
    }
  }, 120_000);

  it('leaves successful startup and normal teardown unchanged', async () => {
    const attempt = newAttemptId();
    const name = `ai-harness-proxy-${attempt}`;

    const reached = await withPhaseNetworks(attempt, 'agent', async (networks) => {
      const outward = networks['proxy-egress'] ?? '';
      const origin = await startOriginContainer(ALLOWED_ORIGIN, outward);
      origins.push(origin);

      try {
        return await withProxy(
          {
            attempt,
            egressNetwork: networks.egress ?? '',
            outwardNetwork: outward,
            allowlist: [ALLOWED_ORIGIN],
            ports: [ORIGIN_PORT],
            images,
          },
          async (handle) => {
            expect(handle.name).toBe(name);
            expect(await containerExists(name)).toBe(true);

            const result = await curlThrough(
              networks.egress ?? '',
              proxyEnvironment(handle),
              `http://${ALLOWED_ORIGIN}:${ORIGIN_PORT}/`,
            );
            return result.stdout;
          },
        );
      } finally {
        await origin.stop();
      }
    });

    expect(reached).toContain('ORIGIN_OK');
    await expect(containerExists(name)).resolves.toBe(false);
  }, 120_000);
});
