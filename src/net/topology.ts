export type Phase = 'agent' | 'setup' | 'verifier' | 'runtime' | 'documentation';

export interface NetworkSpec {
  role: string;
  /** `--internal`: attached containers get no route off the Docker host. */
  internal: boolean;
}

export interface PhaseTopology {
  networks: NetworkSpec[];
  /** The network the phase container joins; `none` means no interfaces but loopback. */
  containerNetwork: string;
}

/**
 * DESIGN.md §6. Never place all phases on one shared egress-capable network.
 *
 * The agent sits on an internal network with no route out; the proxy bridges it to the
 * outward leg. The verifier gets nothing, which is why it cannot reach the proxy.
 */
export const PHASE_TOPOLOGY: Record<Phase, PhaseTopology> = {
  agent: {
    networks: [
      { role: 'egress', internal: true },
      { role: 'proxy-egress', internal: false },
    ],
    containerNetwork: 'egress',
  },
  setup: {
    networks: [{ role: 'registry', internal: false }],
    containerNetwork: 'registry',
  },
  verifier: {
    networks: [],
    containerNetwork: 'none',
  },
  // The application and its behavioral checkers have to reach each other, and nothing else.
  // One internal network gives them Docker DNS and no route to the proxy or the internet.
  runtime: {
    networks: [{ role: 'runtime', internal: true }],
    containerNetwork: 'runtime',
  },
  // The agent phase's shape with its own role names, so the two never share a network even
  // within one attempt: the downloader reaches its declared hosts and nothing else (§18).
  documentation: {
    networks: [
      { role: 'documentation-egress', internal: true },
      { role: 'documentation-proxy-egress', internal: false },
    ],
    containerNetwork: 'documentation-egress',
  },
};

export function phaseTopology(phase: Phase): PhaseTopology {
  return PHASE_TOPOLOGY[phase];
}
