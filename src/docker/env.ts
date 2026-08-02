export const AGENT_HOME = '/home/agent';

/**
 * Container environment is constructed, never inherited: nothing from `process.env` reaches
 * a container. `HOME` is set explicitly because DESIGN.md §5 requires it to point at the
 * writable home tmpfs rather than at a read-only path, and it is applied last so that no
 * caller — including a test injecting an agent environment — can point it elsewhere.
 */
export function buildContainerEnv(declared: Record<string, string> = {}): Record<string, string> {
  return { ...declared, HOME: AGENT_HOME };
}
