import { CliUsageError, parseRunOptions } from './run/options.js';
import { runProduction } from './run/production.js';

let options;

try {
  options = parseRunOptions(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof CliUsageError ? error.message : String(error)}\n`);
  process.exit(2);
}

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

const report = await runProduction({ ...options, signal: controller.signal });

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.status === 'succeeded' && !interrupted ? 0 : 1);
