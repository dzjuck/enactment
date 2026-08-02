import { execa } from 'execa';

import { afterEach, describe, expect, it } from 'vitest';

import { createNetwork } from '../../src/net/manage.js';
import { CleanupError, sweepAttempt } from '../../src/run/cleanup.js';
import { attemptLabels, networkName, newAttemptId, workspaceVolumeName } from '../../src/volume/naming.js';
import { createVolume } from '../../src/volume/workspace.js';
import { runtimeImages } from '../helpers/images.js';

const LABEL = 'ai-harness.attempt';

const strays: string[] = [];

afterEach(async () => {
  for (const name of strays.splice(0)) {
    await execa('docker', ['rm', '--force', name], { reject: false });
  }
});

async function labelled(
  kind: 'container' | 'volume' | 'network',
  attempt: string,
): Promise<string[]> {
  const filter = `label=${LABEL}=${attempt}`;
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', filter]
      : [kind, 'ls', '-q', '--filter', filter];

  const { stdout } = await execa('docker', args);
  return stdout.split('\n').filter((line) => line !== '');
}

/**
 * The state a partially-acquired or interrupted attempt leaves behind: a container still
 * attached to its network, plus a volume. Removing the network first is impossible while the
 * container holds an endpoint, so a sweep that succeeds here is a sweep that ordered itself
 * containers → volumes → networks.
 */
async function leakAttempt(): Promise<string> {
  const attempt = newAttemptId();
  const images = await runtimeImages();

  const network = await createNetwork(networkName(attempt, 'egress'), {
    internal: true,
    labels: attemptLabels(attempt, 'net-egress'),
  });

  await createVolume(workspaceVolumeName(attempt), attemptLabels(attempt, 'workspace'));

  const container = `ai-harness-stray-${attempt}`;
  strays.push(container);
  await execa('docker', [
    'run',
    '--detach',
    '--name',
    container,
    '--label',
    `${LABEL}=${attempt}`,
    '--network',
    network,
    images.verifier.reference,
    'sleep',
    '300',
  ]);

  return attempt;
}

describe('attempt cleanup sweep', () => {
  it('removes an attached container before its network and leaves nothing behind', async () => {
    const attempt = await leakAttempt();

    // Control: without the sweep, all three are demonstrably present.
    await expect(labelled('container', attempt)).resolves.toHaveLength(1);
    await expect(labelled('volume', attempt)).resolves.toHaveLength(1);
    await expect(labelled('network', attempt)).resolves.toHaveLength(1);

    await sweepAttempt(attempt);

    await expect(labelled('container', attempt)).resolves.toEqual([]);
    await expect(labelled('volume', attempt)).resolves.toEqual([]);
    await expect(labelled('network', attempt)).resolves.toEqual([]);
  }, 120_000);

  it('is a no-op for an attempt that owns nothing', async () => {
    await expect(sweepAttempt(newAttemptId())).resolves.toBeUndefined();
  }, 120_000);

  it('reports what survived rather than claiming a clean sweep', async () => {
    const attempt = await leakAttempt();

    // A removal that cannot work: the sweep must say so instead of reporting success.
    const failure = await sweepAttempt(attempt, {
      removeContainer: () => Promise.reject(new Error('daemon refused removal')),
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(CleanupError);
    expect((failure as CleanupError).errors.join('\n')).toContain('daemon refused removal');

    await sweepAttempt(attempt);
    await expect(labelled('network', attempt)).resolves.toEqual([]);
  }, 120_000);
});
