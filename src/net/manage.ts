import { execa } from 'execa';

import { attemptLabels, networkName } from '../volume/naming.js';
import { phaseTopology, type Phase } from './topology.js';

export async function networkExists(name: string): Promise<boolean> {
  const { exitCode } = await execa('docker', ['network', 'inspect', name], { reject: false });
  return exitCode === 0;
}

export async function createNetwork(
  name: string,
  options: { internal: boolean; labels: Record<string, string> },
): Promise<string> {
  const labels = Object.entries(options.labels).flatMap(([key, value]) => [
    '--label',
    `${key}=${value}`,
  ]);

  await execa('docker', [
    'network',
    'create',
    ...(options.internal ? ['--internal'] : []),
    ...labels,
    name,
  ]);

  return name;
}

/** Removing a network that is not there is success, not an error. */
export async function removeNetwork(name: string): Promise<void> {
  await execa('docker', ['network', 'rm', '--force', name], { reject: false });
}

/**
 * Create a phase's topology, run the phase, and destroy the topology — including when the
 * phase throws, which is the case that leaks resources in practice.
 */
export async function withPhaseNetworks<T>(
  attempt: string,
  phase: Phase,
  run: (networks: Record<string, string>) => Promise<T>,
): Promise<T> {
  const networks: Record<string, string> = {};

  try {
    for (const spec of phaseTopology(phase).networks) {
      networks[spec.role] = await createNetwork(networkName(attempt, spec.role), {
        internal: spec.internal,
        labels: attemptLabels(attempt, `net-${spec.role}`),
      });
    }

    return await run(networks);
  } finally {
    await Promise.all(Object.values(networks).map((name) => removeNetwork(name)));
  }
}
