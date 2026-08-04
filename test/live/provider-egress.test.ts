import { describe, expect, it } from 'vitest';

import { providerSmokeTest } from '../../src/adapters/codex/smoke.js';
import { CODEX_PROVIDER_ALLOWLIST, IMAGE_PINS } from '../../src/config/pins.js';
import { runContainer } from '../../src/docker/run.js';
import { withPhaseNetworks } from '../../src/net/manage.js';
import { proxyEnvironment, withProxy } from '../../src/proxy/container.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { runtimeImages } from '../helpers/images.js';

const PROVIDER = 'chatgpt.com';
const DENIED = 'ab.chatgpt.com';

/**
 * §35 regression against the real provider. The hermetic proxy suite proves the mechanism;
 * this proves the destination, and that the allowlist is neither too narrow nor too wide.
 */
describe('real provider egress', () => {
  it('reaches chatgpt.com through the proxy, denies ab.chatgpt.com, and has no direct egress', async () => {
    const attempt = newAttemptId();
    const images = await runtimeImages();

    await withPhaseNetworks(attempt, 'agent', async (networks) => {
      const network = networks.egress ?? '';

      await withProxy(
        {
          attempt,
          egressNetwork: network,
          outwardNetwork: networks['proxy-egress'] ?? '',
          allowlist: CODEX_PROVIDER_ALLOWLIST,
          ports: [443],
          images,
        },
        async (handle) => {
          const env = proxyEnvironment(handle);

          const smoke = await providerSmokeTest({
            url: `https://${PROVIDER}/`,
            network,
            env,
            timeoutSeconds: 30,
            images,
          });
          expect(smoke.ok).toBe(true);

          // A real upgrade request over the tunnel: the response is an HTTP status from
          // the provider, not a connection failure.
          const upgrade = await runContainer({
            image: IMAGE_PINS.codex.tag,
            argv: [
              'curl',
              '-sS',
              '-i',
              '--http1.1',
              '--max-time',
              '30',
              '-H',
              'Connection: Upgrade',
              '-H',
              'Upgrade: websocket',
              '-H',
              'Sec-WebSocket-Version: 13',
              '-H',
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
              `https://${PROVIDER}/backend-api/codex/responses`,
            ],
            network,
            env,
          });
          expect(upgrade.exitCode).toBe(0);
          expect(upgrade.stdout).toMatch(/^HTTP\/1\.1 \d{3}/);

          const denied = await runContainer({
            image: IMAGE_PINS.codex.tag,
            argv: ['curl', '-sS', '--max-time', '20', '-o', '/dev/null', `https://${DENIED}/`],
            network,
            env,
          });
          expect(denied.exitCode).not.toBe(0);

          const direct = await runContainer({
            image: IMAGE_PINS.codex.tag,
            argv: ['curl', '-sS', '--max-time', '20', '-o', '/dev/null', `https://${PROVIDER}/`],
            network,
          });
          expect(direct.exitCode).not.toBe(0);

          const records = await handle.records();
          expect(records.some((r) => r.hostname === PROVIDER && r.allowed)).toBe(true);
          expect(records.some((r) => r.hostname === DENIED && !r.allowed)).toBe(true);
          expect(records.filter((r) => r.allowed).every((r) => r.hostname === PROVIDER)).toBe(true);
        },
      );
    });
  }, 600_000);
});
