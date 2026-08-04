import { CLAUDE_AUTH_PATH } from '../adapters/claude/policy.js';
import { CODEX_HOME_PATH } from '../adapters/codex/policy.js';
import type { Mount } from '../docker/args.js';
import type { RuntimeImages } from '../docker/images.js';
import { runContainer } from '../docker/run.js';
import { withOwnedResource } from '../run/ownership.js';
import { attemptLabels, authVolumeName, type AuthProvider } from '../volume/naming.js';
import { createVolume, removeVolume, volumeExists } from '../volume/workspace.js';
import { AUTH_FILE, AuthError, type AuthStore, updateAuthStore } from './store.js';

/** What a run's CODEX_HOME contains: the credential, plus the compiled policy files. */
export interface CodexAuthVolumeContents {
  provider: 'codex';
  auth: string;
  policy: Record<string, string>;
}

export interface ClaudeAuthVolumeContents {
  provider: 'claude';
  token: string;
}

export type AuthVolumeContents = CodexAuthVolumeContents | ClaudeAuthVolumeContents;

export interface AuthVolumeDependencies {
  seed?: (
    volume: string,
    contents: AuthVolumeContents,
    images: RuntimeImages,
    labels?: Record<string, string>,
  ) => Promise<void>;
  read?: (
    volume: string,
    name: string,
    images: RuntimeImages,
    labels?: Record<string, string>,
  ) => Promise<string>;
}

/**
 * The credential mount is a volume, never a bind of the host store.
 *
 * A bind mount carries host ownership into the container. On a runtime that remaps it — Docker
 * Desktop, OrbStack — that is invisible; on native Linux a mode-0600 file owned by the host
 * user is simply unreadable to uid 1001, and the fix would be to chown the user's own
 * credentials. A volume removes host uid mapping from the container contract entirely.
 *
 * Read-write, because the provider CLI rewrites `auth.json` in place when it rotates (§5).
 */
export function authMount(provider: AuthProvider, volume: string): Mount {
  return {
    type: 'volume',
    source: volume,
    target: provider === 'codex' ? CODEX_HOME_PATH : CLAUDE_AUTH_PATH,
  };
}

/**
 * Write the run's CODEX_HOME through an offline helper running as the agent user.
 *
 * The credential arrives on stdin so it never appears in an argv or an environment variable,
 * where `docker inspect` would preserve it. The policy files are harness-generated and not
 * secret, so they travel as environment values; their names come from the compiled policy,
 * never from a model.
 */
async function seedCodexAuthVolume(
  volume: string,
  contents: CodexAuthVolumeContents,
  images: RuntimeImages,
  labels?: Record<string, string>,
): Promise<void> {
  const env: Record<string, string> = {};
  const script = ['set -e', 'umask 077', `cat > ${CODEX_HOME_PATH}/${AUTH_FILE}`];

  Object.entries(contents.policy).forEach(([name, content], index) => {
    const variable = `HARNESS_POLICY_FILE_${String(index)}`;
    env[variable] = content;
    script.push(`printf '%s' "$${variable}" > ${CODEX_HOME_PATH}/${name}`);
  });

  script.push(`chmod 0600 ${CODEX_HOME_PATH}/*`);

  const result = await runContainer(
    {
      image: images.codex.id,
      argv: ['sh', '-c', script.join('\n')],
      // Offline: a helper holding credentials has no reason to reach anything.
      network: 'none',
      env,
      mounts: [authMount('codex', volume)],
      ...(labels === undefined ? {} : { labels }),
    },
    { input: Buffer.from(contents.auth) },
  );

  if (result.exitCode !== 0) {
    // Names the volume, never the credential.
    throw new AuthError(`seeding auth volume ${volume} failed (${String(result.exitCode)})`);
  }
}

export async function seedClaudeAuthVolume(
  volume: string,
  token: string,
  images: RuntimeImages,
  labels?: Record<string, string>,
): Promise<void> {
  const tokenPath = `${CLAUDE_AUTH_PATH}/token`;
  const result = await runContainer(
    {
      image: images.claude.id,
      argv: ['sh', '-c', `set -e\numask 077\ncat > ${tokenPath}\nchmod 0600 ${tokenPath}`],
      network: 'none',
      mounts: [authMount('claude', volume)],
      ...(labels === undefined ? {} : { labels }),
    },
    { input: Buffer.from(token) },
  );

  if (result.exitCode !== 0) {
    throw new AuthError(`seeding Claude auth volume ${volume} failed (${String(result.exitCode)})`);
  }
}

async function seedAuthVolume(
  volume: string,
  contents: AuthVolumeContents,
  images: RuntimeImages,
  labels?: Record<string, string>,
): Promise<void> {
  if (contents.provider === 'codex') {
    await seedCodexAuthVolume(volume, contents, images, labels);
  } else {
    await seedClaudeAuthVolume(volume, contents.token, images, labels);
  }
}

/**
 * Read one file out of the auth volume through an offline helper.
 *
 * Any non-zero helper exit is an error, never an absent file. A missing credential and one
 * the helper could not read are indistinguishable from here, and both mean the same thing:
 * the harness does not know what the provider left behind. Reporting that as "nothing to copy
 * back" would keep a token the provider may already have replaced, and the run that discovers
 * it is some later one, with no attributable cause.
 */
export async function readAuthVolumeFile(
  volume: string,
  name: string,
  images: RuntimeImages,
  labels?: Record<string, string>,
): Promise<string> {
  const result = await runContainer({
    image: images.codex.id,
    argv: ['cat', `${CODEX_HOME_PATH}/${name}`],
    network: 'none',
    mounts: [authMount('codex', volume)],
    ...(labels === undefined ? {} : { labels }),
  });

  if (result.exitCode !== 0) {
    // Names the file and the volume, never their content.
    throw new AuthError(
      `reading ${name} from auth volume ${volume} failed (${String(result.exitCode)})`,
    );
  }

  return result.stdoutBytes.toString('utf8');
}

/**
 * Create the attempt's credential volume and seed it.
 *
 * Owned from creation: a seeding failure removes the volume rather than leaving a partially
 * written credential directory behind.
 */
export async function createAuthVolume(
  attempt: string,
  contents: AuthVolumeContents,
  images: RuntimeImages,
  dependencies: AuthVolumeDependencies = {},
): Promise<string> {
  const seed = dependencies.seed ?? seedAuthVolume;
  const name = authVolumeName(contents.provider, attempt);

  if (await volumeExists(name)) {
    throw new AuthError(`auth volume ${name} already exists`);
  }

  const labels = attemptLabels(attempt, `auth-${contents.provider}`);
  await createVolume(name, labels);

  return withOwnedResource(name, removeVolume, async () => {
    await seed(name, contents, images, attemptLabels(attempt, `auth-${contents.provider}-seed`));
    return name;
  });
}

/**
 * Take back whatever the provider CLI left behind (§5).
 *
 * Codex rotates `tokens.refresh_token` and rewrites the file; a discarded rotation fails on
 * some later run with no attributable cause. Returns whether the store actually changed.
 *
 * Only a credential that reads back and parses as JSON may replace the established store —
 * the store is the persistent source of truth, and a truncated or wiped run credential must
 * not be renamed over it. Anything else fails the run instead, loudly and with the previous
 * credential intact.
 */
export async function copyBackAuth(
  volume: string,
  store: AuthStore,
  images: RuntimeImages,
  dependencies: AuthVolumeDependencies = {},
  labels?: Record<string, string>,
): Promise<boolean> {
  const read = dependencies.read ?? readAuthVolumeFile;

  const current = await read(volume, AUTH_FILE, images, labels);

  if (current.trim() === '') {
    throw new AuthError(`${AUTH_FILE} from auth volume ${volume} is empty; store left unchanged`);
  }

  try {
    JSON.parse(current);
  } catch {
    // The message names the file, never its content.
    throw new AuthError(
      `${AUTH_FILE} from auth volume ${volume} is not valid JSON; store left unchanged`,
    );
  }

  return updateAuthStore(store, current);
}
