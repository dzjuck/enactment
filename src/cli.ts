import { runTask, type RunOptions } from './run/orchestrator.js';

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function parseAgentEnv(): Record<string, string> | undefined {
  const raw = process.env.HARNESS_AGENT_ENV;
  return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, string>);
}

function usage(): never {
  process.stderr.write('usage: harness run <task.yml> --repo <path> [--artifacts <dir>]\n');
  process.exit(2);
}

const [command, taskFile, ...rest] = process.argv.slice(2);

if (command !== 'run' || taskFile === undefined) usage();

const repoPath = optionValue(rest, 'repo');
if (repoPath === undefined) usage();

const controller = new AbortController();
let interrupted = false;

// The run must be allowed to finish tearing down: exiting on the signal itself would leave
// containers, volumes and networks behind.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    interrupted = true;
    controller.abort();
  });
}

const options: RunOptions = {
  taskFile,
  repoPath,
  artifactDir: optionValue(rest, 'artifacts') ?? 'artifacts',
  signal: controller.signal,
};

const agentImage = optionValue(rest, 'agent-image');
if (agentImage !== undefined) options.agentImage = agentImage;

const agentEnv = parseAgentEnv();
if (agentEnv !== undefined) options.agentEnv = agentEnv;

if (process.env.HARNESS_SOURCE_CODEX_HOME !== undefined) {
  options.sourceCodexHome = process.env.HARNESS_SOURCE_CODEX_HOME;
}
if (process.env.HARNESS_STORE_DIR !== undefined) {
  options.storeDirectory = process.env.HARNESS_STORE_DIR;
}
if (process.env.HARNESS_DEPS_DIR !== undefined) {
  options.dependencyCacheDirectory = process.env.HARNESS_DEPS_DIR;
}

const report = await runTask(options);

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.status === 'succeeded' && !interrupted ? 0 : 1);
