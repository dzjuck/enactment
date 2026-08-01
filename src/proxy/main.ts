import { createAllowlist } from './allowlist.js';
import { jsonlWriter } from './record.js';
import { DEFAULT_PROXY_PORT, startProxy } from './server.js';

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').filter((entry) => entry !== '');
}

const hosts = list(process.env.PROXY_ALLOWED_HOSTS);
const ports = list(process.env.PROXY_ALLOWED_PORTS).map(Number);

const proxy = await startProxy({
  allowlist: createAllowlist({ hosts, ...(ports.length > 0 ? { ports } : {}) }),
  // Records go to stdout; the harness collects them from the container log.
  onRecord: jsonlWriter(process.stdout),
  port: Number(process.env.PROXY_PORT ?? DEFAULT_PROXY_PORT),
});

process.stderr.write(`proxy listening on ${proxy.port} for ${hosts.join(',')}\n`);
