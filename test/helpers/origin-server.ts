import { execa } from 'execa';

import { IMAGE_PINS } from '../../src/config/pins.js';

export const ORIGIN_PORT = 8080;

export interface OriginContainer {
  name: string;
  stop: () => Promise<void>;
}

/**
 * A controllable HTTP origin on the far side of the proxy. Placed on the outward network,
 * never on the agent's internal one, so "reachable only through the proxy" is a real claim.
 */
export async function startOriginContainer(
  name: string,
  network: string,
): Promise<OriginContainer> {
  await execa('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--user',
    '1001:1001',
    '--read-only',
    '--network',
    network,
    IMAGE_PINS.verifier.tag,
    'node',
    '-e',
    `require('http').createServer((_q, s) => s.end('ORIGIN_OK')).listen(${ORIGIN_PORT}, '0.0.0.0')`,
  ]);

  return {
    name,
    stop: async () => {
      await execa('docker', ['rm', '--force', name], { reject: false });
    },
  };
}
