import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkRemovalError, removeNetwork } from '../../src/net/manage.js';

/** Docker's real messages, measured against the daemon rather than guessed. */
const NOT_FOUND = 'Error response from daemon: network ai-harness-net-1-egress not found';
const IN_USE =
  'Error response from daemon: error while removing network: network ai-harness-net-1-egress ' +
  'has active endpoints (name:"probe" id:"e2bfb7331a02")';

const { calls, outcome, fakeExeca } = vi.hoisted(() => {
  const recorded: string[][] = [];
  const next: { stderr?: string } = {};

  const fake = (_file: string, args: string[]): Promise<{ exitCode: number; stderr: string }> => {
    recorded.push(args);

    if (next.stderr === undefined) return Promise.resolve({ exitCode: 0, stderr: '' });

    // execa rejects on a non-zero exit unless told otherwise; the failure carries stderr.
    const error = Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), {
      exitCode: 1,
      stderr: next.stderr,
    });
    return Promise.reject(error);
  };

  return { calls: recorded, outcome: next, fakeExeca: fake };
});

vi.mock('execa', () => ({ execa: fakeExeca }));

beforeEach(() => {
  calls.length = 0;
  delete outcome.stderr;
});

describe('removeNetwork', () => {
  it('removes an existing network', async () => {
    await expect(removeNetwork('ai-harness-net-1-egress')).resolves.toBeUndefined();

    expect(calls).toEqual([['network', 'rm', 'ai-harness-net-1-egress']]);
  });

  it('treats an already-absent network as success', async () => {
    outcome.stderr = NOT_FOUND;

    await expect(removeNetwork('ai-harness-net-1-egress')).resolves.toBeUndefined();
  });

  it('propagates a real removal failure instead of reporting success', async () => {
    outcome.stderr = IN_USE;

    const failure = await removeNetwork('ai-harness-net-1-egress').catch(
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(NetworkRemovalError);
    expect((failure as Error).message).toContain('ai-harness-net-1-egress');
    expect((failure as Error).message).toContain('active endpoints');
  });

  it('propagates a failure it cannot interpret rather than assuming not-found', async () => {
    outcome.stderr = 'Cannot connect to the Docker daemon';

    await expect(removeNetwork('ai-harness-net-1-egress')).rejects.toThrow(NetworkRemovalError);
  });
});
