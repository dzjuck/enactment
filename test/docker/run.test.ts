import { afterEach, describe, expect, it } from 'vitest';

import { IMAGE_PINS } from '../../src/config/pins.js';
import { AGENT_HOME, type ContainerSpec } from '../../src/docker/args.js';
import { runContainer } from '../../src/docker/run.js';
import { imageEnvNames, listContainers } from '../helpers/docker.js';

const IMAGE = IMAGE_PINS.agent.tag;
const TEST_LABEL = 'ai-harness.test=run';

function spec(argv: string[], overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    image: IMAGE,
    argv,
    network: 'none',
    labels: { 'ai-harness.test': 'run' },
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
    process.env.HARNESS_HOST_CANARY = 'must-not-leak';

    const result = await runContainer(spec(['env']));
    const present = result.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split('=')[0] ?? '');

    const declared = new Set([...(await imageEnvNames(IMAGE)), 'HOSTNAME', 'HOME']);
    const surplus = present.filter((name) => !declared.has(name));

    // Names only, never values.
    expect(surplus).toEqual([]);
    expect(present).not.toContain('HARNESS_HOST_CANARY');
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
