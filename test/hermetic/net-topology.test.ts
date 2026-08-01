import { describe, expect, it } from 'vitest';

import { PHASE_TOPOLOGY, phaseTopology } from '../../src/net/topology.js';

describe('phase topology', () => {
  it('gives the agent an internal network plus an outward leg for the proxy', () => {
    const agent = phaseTopology('agent');

    expect(agent.containerNetwork).toBe('egress');
    expect(agent.networks).toEqual([
      { role: 'egress', internal: true },
      { role: 'proxy-egress', internal: false },
    ]);
  });

  it('gives setup a registry network it can actually reach the registry on', () => {
    const setup = phaseTopology('setup');

    expect(setup.containerNetwork).toBe('registry');
    expect(setup.networks).toEqual([{ role: 'registry', internal: false }]);
  });

  it('gives the verifier no network at all', () => {
    const verifier = phaseTopology('verifier');

    expect(verifier.containerNetwork).toBe('none');
    expect(verifier.networks).toEqual([]);
  });

  it('never places two phases on one shared egress-capable network', () => {
    const reachable = Object.values(PHASE_TOPOLOGY).flatMap((topology) =>
      topology.networks.filter((network) => !network.internal).map((network) => network.role),
    );

    expect(new Set(reachable).size).toBe(reachable.length);
  });
});
