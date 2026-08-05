import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_HOME, DEFAULT_LIMITS } from '../../src/docker/args.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { ContainerRemovalError, removeContainer } from '../../src/docker/run.js';
import { startProxyContainer } from '../../src/proxy/container.js';

/** Docker's real messages, measured against the daemon rather than guessed. */
const NO_SUCH = 'Error response from daemon: No such container: ai-harness-app-a1';
const IN_PROGRESS =
  'Error response from daemon: removal of container ai-harness-app-a1 is already in progress';

const { calls, outcome, fakeExeca } = vi.hoisted(() => {
  const recorded: string[][] = [];
  const next: { stderr?: string } = {};

  const fake = (_file: string, args: string[]): Promise<{ exitCode: number; stderr: string }> => {
    recorded.push(args);

    if (next.stderr === undefined) return Promise.resolve({ exitCode: 0, stderr: '' });

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

describe('removeContainer', () => {
  it('removes a retained container by force, so an exited one goes too', async () => {
    await expect(removeContainer('ai-harness-app-a1')).resolves.toBeUndefined();

    expect(calls).toEqual([['rm', '--force', 'ai-harness-app-a1']]);
  });

  it('treats an already-absent container as success, so removal is idempotent', async () => {
    outcome.stderr = NO_SUCH;

    await expect(removeContainer('ai-harness-app-a1')).resolves.toBeUndefined();
  });

  it('propagates a real removal failure with Docker own message', async () => {
    outcome.stderr = IN_PROGRESS;

    const failure = await removeContainer('ai-harness-app-a1').catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ContainerRemovalError);
    expect((failure as Error).message).toContain('ai-harness-app-a1');
    expect((failure as Error).message).toContain('already in progress');
  });

  it('propagates a failure it cannot interpret rather than assuming not-found', async () => {
    outcome.stderr = 'Cannot connect to the Docker daemon';

    await expect(removeContainer('ai-harness-app-a1')).rejects.toThrow(ContainerRemovalError);
  });
});

describe('proxy container retention', () => {
  const images = {
    proxy: { role: 'proxy', id: `sha256:${'d'.repeat(64)}` },
  } as unknown as RuntimeImages;

  it('still runs under --rm, with unchanged argv', async () => {
    await startProxyContainer({
      attempt: 'a1',
      egressNetwork: 'ai-harness-net-a1-agent-egress',
      outwardNetwork: 'ai-harness-net-a1-proxy-egress',
      images,
      allowlist: ['chatgpt.com'],
      ports: [443],
      connect: () => Promise.resolve(),
      waitReady: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    });

    expect(calls).toEqual([
      [
        'run',
        '--rm',
        '--detach',
        '--name',
        'ai-harness-proxy-a1',
        '--user',
        '1001:1001',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit',
        String(DEFAULT_LIMITS.pids),
        '--memory',
        `${DEFAULT_LIMITS.memoryMb}m`,
        '--cpus',
        String(DEFAULT_LIMITS.cpus),
        '--network',
        'ai-harness-net-a1-agent-egress',
        '--workdir',
        '/app',
        '--label',
        'ai-harness.attempt=a1',
        '--label',
        'ai-harness.role=proxy',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,mode=1777',
        '--tmpfs',
        `${AGENT_HOME}:rw,nosuid,nodev,uid=1001,gid=1001,mode=0700`,
        '-e',
        `HOME=${AGENT_HOME}`,
        '-e',
        'PROXY_ALLOWED_HOSTS=chatgpt.com',
        '-e',
        'PROXY_ALLOWED_PORTS=443',
        '-e',
        'PROXY_PORT=3128',
        images.proxy.id,
        'node',
        '/app/main.js',
      ],
    ]);
  });
});
