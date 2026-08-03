import { parseArgs } from 'node:util';

import type { RunOptions } from './bridge.js';

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export const CLI_USAGE = 'usage: harness run <plan.yml> --repo <path> [--artifacts <dir>]';

/**
 * Parse `harness run` into run options.
 *
 * Parsing is strict: an option this function does not declare is an error rather than a
 * value that quietly disappears. There is no image or policy override — the pinned runtime
 * image set is the only thing production can run, and substitution exists only through the
 * internal `RunInjection` seam, which nothing here can reach.
 */
export function parseRunOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): RunOptions {
  let parsed;

  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        repo: { type: 'string' },
        artifacts: { type: 'string' },
      },
    });
  } catch (error) {
    throw new CliUsageError(`${error instanceof Error ? error.message : String(error)}\n${CLI_USAGE}`);
  }

  const [command, planFile, ...surplus] = parsed.positionals;

  if (command !== 'run') throw new CliUsageError(`unknown command "${command ?? ''}"\n${CLI_USAGE}`);
  if (planFile === undefined) throw new CliUsageError(`no plan file given\n${CLI_USAGE}`);
  if (surplus.length > 0) {
    throw new CliUsageError(`unexpected argument "${surplus[0] ?? ''}"\n${CLI_USAGE}`);
  }
  if (parsed.values.repo === undefined) throw new CliUsageError(`--repo is required\n${CLI_USAGE}`);

  const options: RunOptions = {
    planFile,
    repoPath: parsed.values.repo,
    artifactDir: parsed.values.artifacts ?? 'artifacts',
  };

  // Harness state locations only: nothing here reaches the container contract.
  if (env.HARNESS_SOURCE_CODEX_HOME !== undefined) {
    options.sourceCodexHome = env.HARNESS_SOURCE_CODEX_HOME;
  }
  if (env.HARNESS_STORE_DIR !== undefined) options.storeDirectory = env.HARNESS_STORE_DIR;
  if (env.HARNESS_DEPS_DIR !== undefined) options.dependencyCacheDirectory = env.HARNESS_DEPS_DIR;

  return options;
}
