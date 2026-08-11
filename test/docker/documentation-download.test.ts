import { execa } from 'execa';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { IMAGE_PINS } from '../../src/config/pins.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { runContainer } from '../../src/docker/run.js';
import { DocumentationSourceError, derivedHosts, runDocumentationDownload } from '../../src/docs/download.js';
import { withPhaseNetworks } from '../../src/net/manage.js';
import { proxyEnvironment, withProxy } from '../../src/proxy/container.js';
import type { ProxyRecord } from '../../src/proxy/record.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { listContainers } from '../helpers/docker.js';
import { runtimeImages } from '../helpers/images.js';
import { ORIGIN_PORT, startOriginContainer, type OriginContainer } from '../helpers/origin-server.js';

const DECLARED_ORIGIN = 'enactment-docs-origin';
const UNDECLARED_ORIGIN = 'enactment-docs-other';

const SOURCES = [{ url: `https://${DECLARED_ORIGIN}/openapi.json`, path: 'openapi.json' }];

let images: RuntimeImages;
const origins: OriginContainer[] = [];

beforeAll(async () => {
  images = await runtimeImages();
});

afterEach(async () => {
  await Promise.all(origins.splice(0).map((origin) => origin.stop()));
});

async function networkExists(name: string): Promise<boolean> {
  const { exitCode } = await execa('docker', ['network', 'inspect', name], { reject: false });
  return exitCode === 0;
}

/** The documentation phase with both origins standing on the far side of the proxy. */
async function inDocumentationPhase<T>(
  run: (context: { env: Record<string, string>; network: string }) => Promise<T>,
): Promise<{ value: T; proxyRecords: ProxyRecord[] }> {
  const attempt = newAttemptId();

  return withPhaseNetworks(attempt, 'documentation', async (networks) => {
    const outward = networks['documentation-proxy-egress'] ?? '';
    const declared = await startOriginContainer(DECLARED_ORIGIN, outward);
    const undeclared = await startOriginContainer(UNDECLARED_ORIGIN, outward);
    origins.push(declared, undeclared);

    try {
      return await withProxy(
        {
          attempt,
          egressNetwork: networks['documentation-egress'] ?? '',
          outwardNetwork: outward,
          // Exactly what production derives, so this proves the derived list and nothing else.
          allowlist: derivedHosts(SOURCES),
          ports: [ORIGIN_PORT],
          images,
        },
        async (handle) => {
          const value = await run({
            env: proxyEnvironment(handle),
            network: networks['documentation-egress'] ?? '',
          });

          return { value, proxyRecords: await handle.records() };
        },
      );
    } finally {
      await Promise.all([declared.stop(), undeclared.stop()]);
    }
  });
}

function curlThrough(
  network: string,
  env: Record<string, string>,
  url: string,
): ReturnType<typeof runContainer> {
  return runContainer({
    image: IMAGE_PINS.codex.tag,
    argv: ['curl', '-sS', '--proxytunnel', '--max-time', '10', url],
    network,
    env,
  });
}

describe('the derived documentation allowlist', () => {
  it('control: a declared host tunnels, and its record shows it was allowed', async () => {
    const { value, proxyRecords } = await inDocumentationPhase(({ env, network }) =>
      curlThrough(network, env, `http://${DECLARED_ORIGIN}:${ORIGIN_PORT}/`),
    );

    expect(value.stdout).toContain('ORIGIN_OK');
    expect(proxyRecords.some((r) => r.hostname === DECLARED_ORIGIN && r.allowed)).toBe(true);
  }, 120_000);

  it('denies a host outside the declared sources and records the denial', async () => {
    const { value, proxyRecords } = await inDocumentationPhase(({ env, network }) =>
      curlThrough(network, env, `http://${UNDECLARED_ORIGIN}:${ORIGIN_PORT}/`),
    );

    expect(value.exitCode).not.toBe(0);
    expect(value.stdout).not.toContain('ORIGIN_OK');
    expect(proxyRecords.some((r) => r.hostname === UNDECLARED_ORIGIN && !r.allowed)).toBe(true);
  }, 120_000);

  it('reaches nothing at all without the proxy environment: the phase network has no route out', async () => {
    const { value } = await inDocumentationPhase(({ network }) =>
      curlThrough(network, {}, `http://${DECLARED_ORIGIN}:${ORIGIN_PORT}/`),
    );

    expect(value.exitCode).not.toBe(0);
    expect(value.stdout).not.toContain('ORIGIN_OK');
  }, 120_000);
});

describe('runDocumentationDownload leaves nothing behind', () => {
  it('runs the real downloader, reports the unreachable source and cleans up', async () => {
    const attempt = newAttemptId();

    const failure = await runDocumentationDownload({
      attempt,
      sources: [{ url: 'https://enactment-nothing-here.invalid/spec.json', path: 'spec.json' }],
      images,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DocumentationSourceError);
    expect((failure as DocumentationSourceError).reason).toBe('fetch_failed');

    expect(await listContainers(`enactment.attempt=${attempt}`)).toEqual([]);
    expect(await networkExists(`enactment-net-${attempt}-documentation-egress`)).toBe(false);
    expect(await networkExists(`enactment-net-${attempt}-documentation-proxy-egress`)).toBe(false);
  }, 180_000);
});
