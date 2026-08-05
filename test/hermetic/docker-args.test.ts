import { describe, expect, it } from 'vitest';

import {
  AGENT_HOME,
  ContainerSpecError,
  DEFAULT_LIMITS,
  DEFAULT_TMPFS,
  buildRunArgs,
  type ContainerSpec,
} from '../../src/docker/args.js';

const base: ContainerSpec = {
  image: 'ai-harness/agent:test',
  argv: ['echo', 'hello'],
  network: 'none',
  name: 'harness-test',
};

describe('buildRunArgs', () => {
  it('emits the §5 hardening as an exact argv array', () => {
    expect(buildRunArgs(base)).toEqual([
      'run',
      '--rm',
      '--name',
      'harness-test',
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
      'none',
      '--workdir',
      '/workspace',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,mode=1777',
      '--tmpfs',
      `${AGENT_HOME}:rw,nosuid,nodev,uid=1001,gid=1001,mode=0700`,
      '-e',
      `HOME=${AGENT_HOME}`,
      'ai-harness/agent:test',
      'echo',
      'hello',
    ]);
  });

  it('keeps automatic removal by default, including for detached containers', () => {
    expect(buildRunArgs(base)).toContain('--rm');
    expect(buildRunArgs({ ...base, detach: true })).toContain('--rm');
    expect(buildRunArgs({ ...base, autoRemove: true })).toEqual(buildRunArgs(base));
  });

  it('omits --rm only for an explicitly retained container, changing nothing else', () => {
    const removed = buildRunArgs({ ...base, detach: true });
    const retained = buildRunArgs({ ...base, detach: true, autoRemove: false });

    expect(removed).toContain('--rm');
    expect(retained).not.toContain('--rm');
    // Byte-identical apart from the one flag: retention must not relax any §5 hardening.
    expect(retained).toEqual(removed.filter((arg) => arg !== '--rm'));
    expect(retained[0]).toBe('run');
    expect(retained).toContain('--detach');
  });

  it('renders the §5 tmpfs specs exactly', () => {
    const specs = buildRunArgs(base).reduce<string[]>(
      (acc, arg, index, all) => (all[index - 1] === '--tmpfs' ? [...acc, arg] : acc),
      [],
    );

    expect(specs).toEqual([
      '/tmp:rw,nosuid,nodev,mode=1777',
      '/home/agent:rw,nosuid,nodev,uid=1001,gid=1001,mode=0700',
    ]);
    expect(DEFAULT_TMPFS.map((mount) => mount.target)).toEqual(['/tmp', AGENT_HOME]);
  });

  it('rejects a non-/tmp tmpfs declared without numeric ownership', () => {
    expect(() =>
      buildRunArgs({ ...base, tmpfs: [{ target: '/scratch', mode: '0700' }] }),
    ).toThrow(ContainerSpecError);

    expect(() =>
      buildRunArgs({ ...base, tmpfs: [{ target: '/scratch', mode: '0700', uid: 1001, gid: 1001 }] }),
    ).not.toThrow();
  });

  it('renders labels, mounts and explicit environment', () => {
    const args = buildRunArgs({
      ...base,
      workdir: '/app',
      env: { PROXY: 'http://proxy:3128' },
      labels: { 'ai-harness.attempt': 'a1' },
      mounts: [
        { type: 'volume', source: 'ws-a1', target: '/workspace' },
        { type: 'bind', source: '/host/context', target: '/context', readonly: true },
      ],
    });

    expect(args).toContain('--label');
    expect(args).toContain('ai-harness.attempt=a1');
    expect(args).toContain('type=volume,source=ws-a1,target=/workspace');
    expect(args).toContain('type=bind,source=/host/context,target=/context,readonly');
    expect(args).toContain(`HOME=${AGENT_HOME}`);
    expect(args).toContain('PROXY=http://proxy:3128');
    expect(args).toContain('/app');
  });

  it('cannot be made to grant privileges, host network, or the Docker socket', () => {
    const hostile = { ...base, privileged: true, capAdd: ['SYS_ADMIN'] } as ContainerSpec;
    const args = buildRunArgs(hostile);

    expect(args).not.toContain('--privileged');
    expect(args.some((arg) => arg.includes('docker.sock'))).toBe(false);
    expect(args).not.toContain('SYS_ADMIN');
    expect(args).toContain('--cap-drop=ALL');

    expect(() => buildRunArgs({ ...base, network: 'host' })).toThrow(ContainerSpecError);
    expect(() =>
      buildRunArgs({
        ...base,
        mounts: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }],
      }),
    ).toThrow(ContainerSpecError);
  });
});
