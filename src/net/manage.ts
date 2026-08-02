import { execa } from 'execa';

import { CleanupError, releaseAll } from '../run/cleanup.js';
import { OwnershipError } from '../run/ownership.js';
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

export class NetworkRemovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkRemovalError';
  }
}

/**
 * Remove a network, loudly.
 *
 * A network that is already gone is success — that is the idempotent case. Anything else is a
 * failure and is reported as one: the common reason `docker network rm` fails is that a
 * container still holds an endpoint on it, which is precisely the leak that must not be
 * swallowed. Ignoring the exit code turns that leak into a silent one.
 */
export async function removeNetwork(name: string): Promise<void> {
  try {
    await execa('docker', ['network', 'rm', name]);
  } catch (error) {
    const detail = error instanceof Error ? `${errorOutput(error)}${error.message}` : String(error);
    if (/not found/i.test(detail)) return;

    throw new NetworkRemovalError(`failed to remove network ${name}: ${detail.trim()}`);
  }
}

function errorOutput(error: Error): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' && stderr !== '' ? `${stderr}\n` : '';
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
  let outcome: { value: T } | { error: unknown };

  try {
    for (const spec of phaseTopology(phase).networks) {
      networks[spec.role] = await createNetwork(networkName(attempt, spec.role), {
        internal: spec.internal,
        labels: attemptLabels(attempt, `net-${spec.role}`),
      });
    }

    outcome = { value: await run(networks) };
  } catch (error) {
    outcome = { error };
  }

  // Teardown is not in a `finally`: a network that could not be removed has to be reported,
  // and a throw from `finally` would silently replace the phase failure it happened during.
  const errors = await releaseAll(Object.values(networks).map((name) => () => removeNetwork(name)));

  if (errors.length > 0) {
    const cleanup = new CleanupError(errors);

    if ('error' in outcome) {
      throw new OwnershipError(`${phase} networks`, outcome.error, cleanup);
    }
    throw cleanup;
  }

  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}
