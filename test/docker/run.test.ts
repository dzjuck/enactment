import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { IMAGE_PINS } from '../../src/config/pins.js';
import { AGENT_HOME, type ContainerSpec } from '../../src/docker/args.js';
import { containerLogs, removeContainer, runContainer, startContainer } from '../../src/docker/run.js';
import { imageEnvNames, listContainers } from '../helpers/docker.js';

const IMAGE = IMAGE_PINS.codex.tag;
const TEST_LABEL = 'enactment.test=run';

function spec(argv: string[], overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    image: IMAGE,
    argv,
    network: 'none',
    labels: { 'enactment.test': 'run' },
    ...overrides,
  };
}

afterEach(async () => {
  // Every case below, success or failure, must leave nothing behind.
  await expect(listContainers(TEST_LABEL)).resolves.toEqual([]);
});

describe('runContainer', () => {
  it('control: runs a command and captures stdout', async () => {
    const result = await runContainer(spec(['echo', 'hello']));

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('completed');
    expect(result.stdout.trim()).toBe('hello');
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('runs as a non-root user', async () => {
    const result = await runContainer(spec(['id', '-u']));

    expect(result.stdout.trim()).not.toBe('0');
    expect(result.stdout.trim()).toBe('1001');
  });

  it('has a read-only root filesystem but a writable /tmp', async () => {
    const root = await runContainer(spec(['sh', '-c', 'touch /denied']));
    const tmp = await runContainer(spec(['sh', '-c', 'touch /tmp/allowed']));

    expect(root.exitCode).not.toBe(0);
    expect(tmp.exitCode).toBe(0);
  });

  it('drops every capability', async () => {
    const result = await runContainer(spec(['sh', '-c', 'grep CapBnd /proc/self/status']));

    expect(result.stdout.trim()).toBe('CapBnd:\t0000000000000000');
  });

  it('has no outbound network on --network none', async () => {
    const result = await runContainer(
      spec(['curl', '-sS', '--max-time', '5', 'https://example.com']),
    );

    expect(result.exitCode).not.toBe(0);
  });

  it('passes no host environment beyond what the harness declared', async () => {
    process.env.ENACTMENT_HOST_CANARY = 'must-not-leak';

    const result = await runContainer(spec(['env']));
    const present = result.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split('=')[0] ?? '');

    const declared = new Set([...(await imageEnvNames(IMAGE)), 'HOSTNAME', 'HOME']);
    const surplus = present.filter((name) => !declared.has(name));

    // Names only, never values.
    expect(surplus).toEqual([]);
    expect(present).not.toContain('ENACTMENT_HOST_CANARY');
  });

  it('gives the agent a home with no dotfiles', async () => {
    const result = await runContainer(spec(['sh', '-c', `ls -A ${AGENT_HOME}`]));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('gives the agent a writable home at mode 0700', async () => {
    const result = await runContainer(
      spec(['sh', '-c', `touch ${AGENT_HOME}/probe && stat -c %a ${AGENT_HOME}`]),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('700');
  });

  it('sets HOME to the writable home tmpfs', async () => {
    const result = await runContainer(spec(['sh', '-c', 'echo "$HOME" && touch "$HOME/via-home"']));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(AGENT_HOME);
  });

  it('propagates a non-zero exit code with stderr', async () => {
    const result = await runContainer(spec(['sh', '-c', 'echo boom >&2; exit 3']));

    expect(result.exitCode).toBe(3);
    expect(result.status).toBe('completed');
    expect(result.stderr.trim()).toBe('boom');
  });

  it('kills a command that exceeds its timeout and removes its container', async () => {
    const result = await runContainer(spec(['sh', '-c', 'sleep 120']), {
      timeoutSeconds: 2,
      graceSeconds: 1,
    });

    expect(result.status).toBe('timeout');
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeLessThan(30_000);
  });
});

/** Does the container still exist, whatever state it is in? */
async function exists(name: string): Promise<boolean> {
  const { exitCode } = await execa('docker', ['container', 'inspect', name], { reject: false });
  return exitCode === 0;
}

async function waitUntilGone(name: string, attempts = 100): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await exists(name))) return true;
    await delay(50);
  }
  return false;
}

describe('retained containers', () => {
  it('control: a default detached container is removed by Docker when it exits', async () => {
    const name = `harness-auto-${randomUUID().slice(0, 8)}`;

    await startContainer(spec(['sh', '-c', 'echo auto-marker; exit 7'], { name }));

    expect(await waitUntilGone(name)).toBe(true);
  });

  it('keeps an exited autoRemove:false container until it is removed loudly', async () => {
    const name = `harness-retained-${randomUUID().slice(0, 8)}`;

    await startContainer(
      spec(['sh', '-c', 'echo retained-marker >&2; exit 7'], { name, autoRemove: false }),
    );

    // The evidence case: the container crashed, and its logs are still there to read.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { stdout } = await execa('docker', [
        'container',
        'inspect',
        '--format',
        '{{.State.Status}}',
        name,
      ]);
      if (stdout.trim() === 'exited') break;
      await delay(50);
    }

    expect(await exists(name)).toBe(true);
    expect((await containerLogs(name)).stderr).toContain('retained-marker');

    await removeContainer(name);
    expect(await exists(name)).toBe(false);

    // Removal is idempotent: an already-gone container is success, not a failure.
    await expect(removeContainer(name)).resolves.toBeUndefined();
  });
});
