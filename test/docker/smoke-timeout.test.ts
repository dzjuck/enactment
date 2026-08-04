import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../src/artifacts/store.js';
import { IMAGE_PINS } from '../../src/config/pins.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { runContainer } from '../../src/docker/run.js';
import { exportCommit } from '../../src/git/export.js';
import { withPhaseNetworks } from '../../src/net/manage.js';
import { proxyEnvironment, withProxy } from '../../src/proxy/container.js';
import { PhaseFailure } from '../../src/run/failure.js';
import { providerSmokeTest, withProviderSmokeTest } from '../../src/adapters/codex/smoke.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { restoreWorkspace, snapshotWorkspace } from '../../src/volume/snapshot.js';
import { createWorkspaceVolume, removeVolume, workspaceMount } from '../../src/volume/workspace.js';
import { ORIGIN_PORT, startOriginContainer } from '../helpers/origin-server.js';
import { runtimeImages } from '../helpers/images.js';
import { createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';

const ORIGIN = 'ai-harness-smoke-origin';

let repo: TargetRepo;
let tar: Buffer;
let store: ArtifactStore;
let storeRoot: string;
let images: RuntimeImages;

beforeAll(async () => {
  images = await runtimeImages();
  repo = await createTargetRepo();
  ({ tar } = await exportCommit(repo.dir, repo.commit));
  storeRoot = await mkdtemp(join(tmpdir(), 'harness-smoke-'));
  store = new ArtifactStore(storeRoot);
}, 120_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(storeRoot, { recursive: true, force: true });
});

/** Runs a body inside a real agent topology: internal network, proxy, origin outside. */
async function inAgentPhase<T>(
  run: (context: { network: string; env: Record<string, string> }) => Promise<T>,
  options: { withOrigin?: boolean } = {},
): Promise<T> {
  const attempt = newAttemptId();

  return withPhaseNetworks(attempt, 'agent', async (networks) => {
    const outward = networks['proxy-egress'] ?? '';
    const origin =
      options.withOrigin === false ? undefined : await startOriginContainer(ORIGIN, outward);

    try {
      return await withProxy(
        {
          attempt,
          egressNetwork: networks.egress ?? '',
          outwardNetwork: outward,
          allowlist: [ORIGIN],
          ports: [ORIGIN_PORT],
          images,
        },
        (handle) => run({ network: networks.egress ?? '', env: proxyEnvironment(handle) }),
      );
    } finally {
      await origin?.stop();
    }
  });
}

const SMOKE_URL = `http://${ORIGIN}:${ORIGIN_PORT}/`;

describe('provider connectivity smoke test', () => {
  it('control: passes against a reachable allowlisted origin', async () => {
    const result = await inAgentPhase(({ network, env }) =>
      providerSmokeTest({ url: SMOKE_URL, network, env, timeoutSeconds: 20, images }),
    );

    expect(result.ok).toBe(true);
  }, 120_000);

  it('fails within its own budget when the provider is unreachable', async () => {
    const started = Date.now();

    const failure = await inAgentPhase(
      ({ network, env }) =>
        providerSmokeTest({ url: SMOKE_URL, network, env, timeoutSeconds: 15, images }).catch(
          (cause: unknown) => cause,
        ),
      { withOrigin: false },
    );

    expect(failure).toBeInstanceOf(PhaseFailure);
    expect((failure as PhaseFailure).category).toBe('provider_connectivity_timeout');
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 120_000);

  it('stops the agent phase from starting at all when it fails', async () => {
    let agentStarted = false;

    const failure = await inAgentPhase(
      ({ network, env }) =>
        withProviderSmokeTest(
          { url: SMOKE_URL, network, env, timeoutSeconds: 15, images },
          async () => {
            agentStarted = true;
            return 'agent ran';
          },
        ).catch((cause: unknown) => cause),
      { withOrigin: false },
    );

    expect(failure).toBeInstanceOf(PhaseFailure);
    expect(agentStarted).toBe(false);
  }, 120_000);
});

describe('termination ladder against a real container', () => {
  it('kills a container that ignores SIGTERM instead of hanging', async () => {
    const started = Date.now();

    const result = await runContainer(
      {
        image: IMAGE_PINS.codex.tag,
        argv: ['sh', '-c', 'trap "" TERM; while true; do sleep 1; done'],
        network: 'none',
      },
      { timeoutSeconds: 3, graceSeconds: 2 },
    );

    expect(result.status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(45_000);
  }, 120_000);

  it('restores the pre-invocation workspace after a timeout', async () => {
    const volume = await createWorkspaceVolume(newAttemptId(), tar, images);

    try {
      const before = await runContainer({
        image: IMAGE_PINS.codex.tag,
        argv: ['sh', '-c', 'find /workspace -mindepth 1 | sort'],
        network: 'none',
        mounts: [workspaceMount(volume)],
      });
      const snapshot = await snapshotWorkspace(volume, store, images);

      const timedOut = await runContainer(
        {
          image: IMAGE_PINS.codex.tag,
          argv: [
            'sh',
            '-c',
            'trap "" TERM; rm -rf /workspace/src; touch /workspace/HALF_WRITTEN; while true; do sleep 1; done',
          ],
          network: 'none',
          mounts: [workspaceMount(volume)],
        },
        { timeoutSeconds: 3, graceSeconds: 2 },
      );
      expect(timedOut.status).toBe('timeout');

      await restoreWorkspace(volume, snapshot, images);

      const after = await runContainer({
        image: IMAGE_PINS.codex.tag,
        argv: ['sh', '-c', 'find /workspace -mindepth 1 | sort'],
        network: 'none',
        mounts: [workspaceMount(volume)],
      });

      expect(after.stdout).toBe(before.stdout);
      expect(after.stdout).not.toContain('HALF_WRITTEN');
      expect(after.stdout).toContain('/workspace/src/slugify.js');
    } finally {
      await removeVolume(volume);
    }
  }, 180_000);
});
