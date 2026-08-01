import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { IMAGE_PINS } from '../../src/config/pins.js';
import { runContainer, type RunResult } from '../../src/docker/run.js';
import { withPhaseNetworks } from '../../src/net/manage.js';
import {
  proxyEnvironment,
  withProxy,
  writeProxyRecords,
  type ProxyHandle,
} from '../../src/proxy/container.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { ORIGIN_PORT, startOriginContainer, type OriginContainer } from '../helpers/origin-server.js';

const ALLOWED_ORIGIN = 'ai-harness-origin-allowed';
const DENIED_ORIGIN = 'ai-harness-origin-denied';

let artifactDir: string;
const origins: OriginContainer[] = [];

beforeAll(async () => {
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
