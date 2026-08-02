import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { IMAGE_PINS } from '../../src/config/pins.js';
import { runContainer, type RunResult } from '../../src/docker/run.js';
import { networkExists, withPhaseNetworks } from '../../src/net/manage.js';
import { newAttemptId, networkName } from '../../src/volume/naming.js';
import { startDetached, type DetachedContainer } from '../helpers/background.js';

const listeners: DetachedContainer[] = [];

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.stop()));
});

async function isInternal(name: string): Promise<boolean> {
  const { stdout } = await execa('docker', [
    'network',
    'inspect',
    '--format',
    '{{.Internal}}',
    name,
  ]);
  return stdout.trim() === 'true';
}

function onNetwork(network: string, argv: string[]): Promise<RunResult> {
  return runContainer({ image: IMAGE_PINS.agent.tag, argv, network });
}

const LISTENER = [
  'node',
  '-e',
  "require('net').createServer((s) => s.end('ok')).listen(3128, '0.0.0.0')",
];

const connectProbe = (ip: string): string[] => [
  'node',
  '-e',
  `const s = require('net').connect(3128, ${JSON.stringify(ip)});` +
    "s.on('connect', () => process.exit(0));" +
    "s.on('error', () => process.exit(7));" +
    'setTimeout(() => process.exit(8), 4000);',
];

describe('per-phase networks', () => {
  it('marks a network internal only where the phase must not reach the host network', async () => {
    await withPhaseNetworks(newAttemptId(), 'agent', async (networks) => {
      await expect(isInternal(networks.egress ?? '')).resolves.toBe(true);
      await expect(isInternal(networks['proxy-egress'] ?? '')).resolves.toBe(false);
    });
  });

  it('names networks per attempt, uniquely across concurrent attempts', async () => {
    const first = newAttemptId();
    const second = newAttemptId();
    const names: string[] = [];

    await Promise.all([
      withPhaseNetworks(first, 'setup', async (networks) => {
        names.push(networks.registry ?? '');
      }),
      withPhaseNetworks(second, 'setup', async (networks) => {
        names.push(networks.registry ?? '');
      }),
    ]);

    expect(new Set(names).size).toBe(2);
    expect(names.sort()).toEqual(
      [networkName(first, 'registry'), networkName(second, 'registry')].sort(),
    );
    expect(names.every((name) => name.startsWith('ai-harness-'))).toBe(true);
  });

  it('destroys the networks when the phase ends', async () => {
    let created = '';

    await withPhaseNetworks(newAttemptId(), 'setup', async (networks) => {
      created = networks.registry ?? '';
      await expect(networkExists(created)).resolves.toBe(true);
    });

    await expect(networkExists(created)).resolves.toBe(false);
  });

  it('destroys the networks when the phase throws', async () => {
    let created = '';

    await expect(
      withPhaseNetworks(newAttemptId(), 'setup', async (networks) => {
        created = networks.registry ?? '';
        throw new Error('phase exploded');
      }),
    ).rejects.toThrow('phase exploded');

    await expect(networkExists(created)).resolves.toBe(false);
  });

  it('leaves the agent network without direct egress, while the registry network has it', async () => {
    await withPhaseNetworks(newAttemptId(), 'agent', async (networks) => {
      const denied = await onNetwork(networks.egress ?? '', [
        'curl',
        '-sS',
        '--max-time',
        '8',
        'https://registry.npmjs.org/',
      ]);
      expect(denied.exitCode).not.toBe(0);
    });

    // Control: the same request succeeds where the phase is meant to have egress.
    await withPhaseNetworks(newAttemptId(), 'setup', async (networks) => {
      const allowed = await onNetwork(networks.registry ?? '', [
        'curl',
        '-sS',
        '--max-time',
        '20',
        '-o',
        '/dev/null',
        'https://registry.npmjs.org/',
      ]);
      expect(allowed.exitCode).toBe(0);
    });
  }, 120_000);

  it('gives a verifier container nothing but loopback', async () => {
    const result = await runContainer({
      image: IMAGE_PINS.verifier.tag,
      argv: ['sh', '-c', 'ls /sys/class/net | sort | tr "\\n" ","'],
      network: 'none',
    });

    expect(result.stdout.trim()).toBe('lo,');
  });

  it('keeps the verifier away from the proxy even while the proxy is listening', async () => {
    await withPhaseNetworks(newAttemptId(), 'agent', async (networks) => {
      const listener = await startDetached({
        image: IMAGE_PINS.agent.tag,
        argv: LISTENER,
        network: networks.egress ?? '',
        name: `ai-harness-listener-${newAttemptId()}`,
      });
      listeners.push(listener);

      try {
        // Control: a container on the agent network does reach it.
        const reachable = await onNetwork(networks.egress ?? '', connectProbe(listener.ip));
        expect(reachable.exitCode).toBe(0);

        const verifier = await runContainer({
          image: IMAGE_PINS.verifier.tag,
          argv: connectProbe(listener.ip),
          network: 'none',
        });
        expect(verifier.exitCode).not.toBe(0);
      } finally {
        // Stopped inside the phase: a container still holding an endpoint blocks the
        // network's removal, and phase teardown now reports that rather than leaking.
        await listener.stop();
      }
    });
  }, 120_000);
});
