import { AGENT_GID, AGENT_UID } from '../config/pins.js';
import { AGENT_HOME, buildContainerEnv } from './env.js';

export class ContainerSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerSpecError';
  }
}

export { AGENT_HOME };

/** DESIGN.md §5. `memory_mb` currently exceeds the OrbStack VM; recorded as an open risk. */
export const DEFAULT_LIMITS = {
  memoryMb: 8192,
  cpus: 4,
  pids: 512,
};

export interface TmpfsMount {
  target: string;
  /** Octal, as docker expects it: `1777`, `0700`. */
  mode: string;
  uid?: number;
  gid?: number;
}

/**
 * DESIGN.md §5: Docker special-cases `/tmp` to `1777`; every other tmpfs target is created
 * `0755 root:root`, which a non-root agent cannot write.
 */
export const DEFAULT_TMPFS: readonly TmpfsMount[] = [
  { target: '/tmp', mode: '1777' },
  { target: AGENT_HOME, mode: '0700', uid: AGENT_UID, gid: AGENT_GID },
];

export type Mount =
  | { type: 'volume'; source: string; target: string; readonly?: boolean }
  | { type: 'bind'; source: string; target: string; readonly?: boolean };

export interface ContainerSpec {
  image: string;
  /** A fixed argument array (§16). Never a shell string. */
  argv: string[];
  /** Network name, or `none`. `host` is not expressible. */
  network: string;
  name?: string;
  /** Keep stdin open, so the harness can stream a tar into the container. */
  interactive?: boolean;
  /** Run in the background: for the proxy, which must outlive a single command. */
  detach?: boolean;
  /**
   * Whether Docker removes the container when it exits. Defaults to `true`.
   *
   * Only a detached application under runtime verification sets `false`: an application that
   * crashes on startup would otherwise be removed before `docker logs` runs, which is exactly
   * the evidence that failure needs. A retained container is removed explicitly and loudly by
   * its owner (`removeContainer`), never left to a label sweep.
   */
  autoRemove?: boolean;
  workdir?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  mounts?: Mount[];
  tmpfs?: readonly TmpfsMount[];
  limits?: Partial<typeof DEFAULT_LIMITS>;
}

function renderTmpfs(mount: TmpfsMount): string {
  if (mount.target !== '/tmp' && (mount.uid === undefined || mount.gid === undefined)) {
    throw new ContainerSpecError(
      `tmpfs "${mount.target}" needs explicit uid and gid: only /tmp is created world-writable, ` +
        `every other target would be 0755 root:root and unwritable by the agent`,
    );
  }

  const ownership = mount.uid === undefined ? '' : `,uid=${mount.uid},gid=${mount.gid}`;
  return `${mount.target}:rw,nosuid,nodev${ownership},mode=${mount.mode}`;
}

function renderMount(mount: Mount): string {
  if (/docker\.sock$/.test(mount.source) || mount.source.startsWith('/var/run/docker')) {
    throw new ContainerSpecError(`refusing to mount the Docker socket (${mount.source})`);
  }

  const parts = [`type=${mount.type}`, `source=${mount.source}`, `target=${mount.target}`];
  if (mount.readonly === true) parts.push('readonly');
  return parts.join(',');
}

/**
 * Build the full `docker run` argv. Pure, so the hardening is a testable value rather than
 * a runtime behavior. There is no code path that adds `--privileged`, the Docker socket, or
 * host networking: they are not representable in `ContainerSpec`.
 */
export function buildRunArgs(spec: ContainerSpec): string[] {
  if (spec.network === 'host') {
    throw new ContainerSpecError('host networking is not permitted');
  }

  const limits = { ...DEFAULT_LIMITS, ...spec.limits };
  const env = buildContainerEnv(spec.env);
  const tmpfs = spec.tmpfs ?? DEFAULT_TMPFS;

  const args = ['run', ...(spec.autoRemove === false ? [] : ['--rm'])];

  if (spec.detach === true) args.push('--detach');
  if (spec.interactive === true) args.push('--interactive');
  if (spec.name !== undefined) args.push('--name', spec.name);

  args.push(
    '--user',
    `${AGENT_UID}:${AGENT_GID}`,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit',
    String(limits.pids),
    '--memory',
    `${limits.memoryMb}m`,
    '--cpus',
    String(limits.cpus),
    '--network',
    spec.network,
    '--workdir',
    spec.workdir ?? '/workspace',
  );

  for (const [key, value] of Object.entries(spec.labels ?? {}).sort()) {
    args.push('--label', `${key}=${value}`);
  }

  for (const mount of tmpfs) {
    args.push('--tmpfs', renderTmpfs(mount));
  }

  for (const mount of spec.mounts ?? []) {
    args.push('--mount', renderMount(mount));
  }

  for (const [key, value] of Object.entries(env).sort()) {
    args.push('-e', `${key}=${value}`);
  }

  args.push(spec.image, ...spec.argv);
  return args;
}
