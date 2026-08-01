export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowlistError';
  }
}

export interface AllowlistConfig {
  hosts: string[];
  ports?: number[];
}

export interface Allowlist {
  readonly hosts: readonly string[];
  readonly ports: readonly number[];
  allows(host: string, port: number): boolean;
}

export const DEFAULT_PORTS = [443];

function normalize(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * DESIGN.md §7: a hostname is allowed only if it appears in the list verbatim. No substring
 * matching, no implicit subdomains, no wildcards — and a wildcard entry is a configuration
 * error rather than a literal hostname that would quietly match nothing.
 */
export function createAllowlist(config: AllowlistConfig): Allowlist {
  const hosts = config.hosts.map(normalize);

  for (const host of hosts) {
    if (host.includes('*') || host.includes('?')) {
      throw new AllowlistError(
        `wildcards are unsupported; "${host}" must be an exact hostname (§7, §36)`,
      );
    }
    if (host === '') {
      throw new AllowlistError('allowlist entries must not be empty');
    }
  }

  const allowed = new Set(hosts);
  const ports = config.ports ?? DEFAULT_PORTS;

  return {
    hosts,
    ports,
    allows: (host, port) => allowed.has(normalize(host)) && ports.includes(port),
  };
}
