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

  it('gives the runtime check exactly one internal network and no egress leg', () => {
    const runtime = phaseTopology('runtime');

    expect(runtime.containerNetwork).toBe('runtime');
    expect(runtime.networks).toEqual([{ role: 'runtime', internal: true }]);
    expect(runtime.networks.map((network) => network.role)).not.toContain('egress');
    expect(runtime.networks.map((network) => network.role)).not.toContain('proxy-egress');
    expect(runtime.networks.every((network) => network.internal)).toBe(true);
  });

  it('gives the documentation downloader an internal network plus its own outward leg', () => {
    const documentation = phaseTopology('documentation');

    expect(documentation.containerNetwork).toBe('documentation-egress');
    expect(documentation.networks).toEqual([
      { role: 'documentation-egress', internal: true },
      { role: 'documentation-proxy-egress', internal: false },
    ]);
  });

  it('never places two phases on one shared egress-capable network', () => {
    const reachable = Object.values(PHASE_TOPOLOGY).flatMap((topology) =>
      topology.networks.filter((network) => !network.internal).map((network) => network.role),
    );

    expect(new Set(reachable).size).toBe(reachable.length);
  });
});
