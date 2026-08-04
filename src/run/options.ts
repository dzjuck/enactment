import { parseArgs } from 'node:util';

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export const CLI_USAGE = [
  'usage:',
  '  harness prepare <plan.yml> --repo <path> --output <execution-manifest.yml>',
  '  harness run <execution-manifest.yml> --repo <path> [--artifacts <dir>]',
  '  harness cancel <execution-manifest.yml> --repo <path> [--artifacts <dir>]',
].join('\n');

/** Harness state locations only. Nothing here reaches the container contract. */
export interface StateLocations {
  sourceCodexHome?: string;
  storeDirectory?: string;
  dependencyCacheDirectory?: string;
  /** Where `state.db` lives; the plan database is opened under it. */
  stateDirectory?: string;
}

export interface PrepareCommand extends StateLocations {
  kind: 'prepare';
  planFile: string;
  repoPath: string;
  output: string;
}

export interface RunCommand extends StateLocations {
  kind: 'run';
  manifestPath: string;
  repoPath: string;
  artifactDir: string;
}

export interface CancelCommand extends StateLocations {
  kind: 'cancel';
  manifestPath: string;
  repoPath: string;
  /** Where the plan tree lives, so retiring a plan can release its snapshots. */
  artifactDir: string;
}

export type Command = PrepareCommand | RunCommand | CancelCommand;

/** Which options each command accepts. An option outside its command's set is an error. */
const ACCEPTED = {
  prepare: ['repo', 'output'],
  run: ['repo', 'artifacts'],
  cancel: ['repo', 'artifacts'],
} as const;

function stateLocations(env: NodeJS.ProcessEnv): StateLocations {
  const locations: StateLocations = {};

  if (env.HARNESS_SOURCE_CODEX_HOME !== undefined) {
    locations.sourceCodexHome = env.HARNESS_SOURCE_CODEX_HOME;
  }
  if (env.HARNESS_STORE_DIR !== undefined) locations.storeDirectory = env.HARNESS_STORE_DIR;
  if (env.HARNESS_DEPS_DIR !== undefined) locations.dependencyCacheDirectory = env.HARNESS_DEPS_DIR;
  if (env.HARNESS_STATE_DIR !== undefined) locations.stateDirectory = env.HARNESS_STATE_DIR;

  return locations;
}

/**
 * Parse one supported command.
 *
 * Parsing is strict twice over: an option this function does not declare is an error, and an
 * option belonging to a *different* command is an error too. There is no image, network or
 * policy override anywhere — the approved manifest is the only thing production executes
 * from, and substitution exists solely through the internal `RunInjection` seam, which
 * nothing here can reach.
 */
export function parseCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Command {
  const [name, ...rest] = argv;

  if (name !== 'prepare' && name !== 'run' && name !== 'cancel') {
    throw new CliUsageError(`unknown command "${name ?? ''}"\n${CLI_USAGE}`);
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries(
        ACCEPTED[name].map((option) => [option, { type: 'string' as const }]),
      ),
    });
  } catch (error) {
    throw new CliUsageError(
      `${error instanceof Error ? error.message : String(error)}\n${CLI_USAGE}`,
    );
  }

  const [file, ...surplus] = parsed.positionals;
  if (file === undefined) {
    throw new CliUsageError(
      `${name} needs a ${name === 'prepare' ? 'plan' : 'manifest'} file\n${CLI_USAGE}`,
    );
  }
  if (surplus.length > 0) {
    throw new CliUsageError(`unexpected argument "${surplus[0] ?? ''}"\n${CLI_USAGE}`);
  }

  const repoPath = parsed.values.repo;
  if (repoPath === undefined) throw new CliUsageError(`--repo is required\n${CLI_USAGE}`);

  const locations = stateLocations(env);

  if (name === 'prepare') {
    const output = parsed.values.output;
    if (output === undefined) throw new CliUsageError(`--output is required\n${CLI_USAGE}`);
    return { kind: 'prepare', planFile: file, repoPath, output, ...locations };
  }

  // Same default as `run`, because it names the same tree: an operator who passed
  // `--artifacts` to the run passes it here too, and one who did not needs neither.
  const artifactDir = parsed.values.artifacts ?? 'artifacts';

  if (name === 'cancel') {
    return { kind: 'cancel', manifestPath: file, repoPath, artifactDir, ...locations };
  }

  return { kind: 'run', manifestPath: file, repoPath, artifactDir, ...locations };
}
