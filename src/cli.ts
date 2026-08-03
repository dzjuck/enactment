import { CliUsageError, parseCommand } from './run/options.js';
import { execute } from './run/production.js';

let command;

try {
  command = parseCommand(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof CliUsageError ? error.message : String(error)}\n`);
  process.exit(2);
}

const controller = new AbortController();

// A run must be allowed to finish tearing down: exiting on the signal itself would leave
// containers, volumes and networks behind.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    controller.abort();
  });
}

const result = await execute(command, {}, controller.signal);

process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
process.exit(result.exitCode);
