import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCodexAgent } from '../../src/adapters/codex/run.js';
import { providerSmokeTest } from '../../src/adapters/codex/smoke.js';
import { ArtifactStore, type StoredArtifact } from '../../src/artifacts/store.js';
import { IMAGE_PINS, IMAGE_ROLES, type ImageRole } from '../../src/config/pins.js';
import { DependencyCache, ensureDependencySnapshot } from '../../src/deps/setup.js';
import { createDependencyVolume } from '../../src/deps/volume.js';
import { resolveRuntimeImages, type RuntimeImages } from '../../src/docker/images.js';
import { startProxyContainer } from '../../src/proxy/container.js';
import { runtimeSection } from '../../src/run/manifest.js';
import { runVerification } from '../../src/verify/run.js';
import { restoreWorkspace, snapshotWorkspace } from '../../src/volume/snapshot.js';
import { initSyntheticGit } from '../../src/volume/synthetic-git.js';
import { createWorkspaceVolume } from '../../src/volume/workspace.js';

/**
 * Container execution is recorded rather than performed, so this suite can prove which image
 * reference every phase actually ran — the claim Step 22 exists to make — without a daemon.
 */
const { calls, fakeExeca } = vi.hoisted(() => {
  const recorded: string[][] = [];

  const fake = (
    _file: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: Buffer | string; stderr: Buffer | string }> => {
    recorded.push(args);

    // A fresh volume name must look absent, or the create paths refuse to proceed.
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'no such volume' });
    }

    // The proxy hands out a handle only once it has seen this line.
    if (args[0] === 'logs') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: 'proxy listening on 8080' });
    }

    return Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  };

  return { calls: recorded, fakeExeca: fake };
});

vi.mock('execa', () => ({ execa: fakeExeca }));

const digits = (value: number): string => `sha256:${String(value).repeat(64)}`;

const IMAGES = Object.fromEntries(
  IMAGE_ROLES.map((role, index) => [
    role,
    { role, reference: digits(index + 1), digest: digits(index + 5) },
  ]),
) as RuntimeImages;

const REFERENCES = new Set(IMAGE_ROLES.map((role) => IMAGES[role].reference));
const TAGS = IMAGE_ROLES.map((role) => IMAGE_PINS[role].tag);

/** The image each recorded `docker run` was given: `buildRunArgs` puts it after every flag. */
function imagesRun(): string[] {
  return calls
    .filter((args) => args[0] === 'run')
    .map((args) => args.find((arg) => arg.startsWith('sha256:')) ?? '<none>');
}

let dir: string;

beforeEach(async () => {
  calls.length = 0;
  dir = await mkdtemp(join(tmpdir(), 'harness-runtime-images-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function storedArtifact(): Promise<StoredArtifact> {
  return new ArtifactStore(join(dir, 'artifacts')).put(Buffer.from('snapshot-bytes'));
}

describe('runtime image identity', () => {
  it('resolves each role to a runnable reference and its verified content digest', async () => {
    const layers: Record<ImageRole, string> = {
      agent: '["sha256:aaa"]',
      verifier: '["sha256:bbb"]',
      setup: '["sha256:ccc"]',
      proxy: '["sha256:ddd"]',
    };
    const ids: Record<ImageRole, string> = {
      agent: digits(1),
      verifier: digits(2),
      setup: digits(3),
      proxy: digits(4),
    };

    const exec = (args: string[]): Promise<string> => {
      const target = args.at(-1) ?? '';
      const role = IMAGE_ROLES.find((candidate) => target.includes(candidate));
      if (role === undefined) throw new Error(`unexpected invocation: ${args.join(' ')}`);
      return Promise.resolve(args.includes('{{.Id}}') ? ids[role] : layers[role]);
    };

    const pins = Object.fromEntries(
      IMAGE_ROLES.map((role) => [
        role,
        `sha256:${createHash('sha256').update(layers[role]).digest('hex')}`,
      ]),
    ) as Record<ImageRole, string>;

    const images = await resolveRuntimeImages({ pins, platform: 'linux/arm64', exec });

    for (const role of IMAGE_ROLES) {
      expect(images[role]).toEqual({ role, reference: ids[role], digest: pins[role] });
    }
  });
});

describe('phases execute the supplied runtime image set', () => {
  it('seeds the workspace volume with the setup reference', async () => {
    await createWorkspaceVolume('attempt-1', Buffer.from('tar'), IMAGES);

    expect(imagesRun()).toEqual([IMAGES.setup.reference]);
  });

  it('initializes synthetic git with the agent reference', async () => {
    await initSyntheticGit('ai-harness-ws-attempt-1', IMAGES);

    expect(imagesRun()).toEqual([IMAGES.agent.reference]);
  });

  it('snapshots and restores the workspace with the setup reference', async () => {
    const store = new ArtifactStore(join(dir, 'snapshots'));
    await snapshotWorkspace('ai-harness-ws-attempt-1', store, IMAGES);
    await restoreWorkspace('ai-harness-ws-attempt-1', await storedArtifact(), IMAGES);

    expect(imagesRun()).toEqual([IMAGES.setup.reference, IMAGES.setup.reference]);
  });

  it('seeds a dependency volume with the setup reference', async () => {
    await createDependencyVolume('attempt-1', 'agent', Buffer.alloc(0), IMAGES);

    expect(imagesRun()).toEqual([IMAGES.setup.reference]);
  });

  it('installs dependencies with the setup reference', async () => {
    await ensureDependencySnapshot({
      cache: new DependencyCache(join(dir, 'deps')),
      key: 'sha256:cold',
      attempt: 'attempt-1',
      workspaceTar: Buffer.from('tar'),
      installCommand: ['npm', 'ci', '--ignore-scripts'],
      network: 'ai-harness-net-attempt-1-registry',
      images: IMAGES,
    });

    expect(new Set(imagesRun())).toEqual(new Set([IMAGES.setup.reference]));
  });

  it('runs verification with the verifier reference', async () => {
    await runVerification({
      attempt: 'attempt-1',
      snapshot: await storedArtifact(),
      dependencySnapshot: Buffer.alloc(0),
      commands: [['npx', 'vitest', 'run']],
      artifactDir: join(dir, 'artifacts'),
      images: IMAGES,
    });

    // The disposable copy is seeded by setup containers; the commands are the verifier's.
    expect(imagesRun()).toContain(IMAGES.verifier.reference);
    expect(new Set(imagesRun())).toEqual(
      new Set([IMAGES.setup.reference, IMAGES.verifier.reference]),
    );
  });

  it('starts the proxy from the proxy reference', async () => {
    await startProxyContainer({
      attempt: 'attempt-1',
      egressNetwork: 'egress',
      outwardNetwork: 'outward',
      images: IMAGES,
    });

    expect(imagesRun()).toEqual([IMAGES.proxy.reference]);
  });

  it('runs the connectivity smoke test from the agent reference', async () => {
    await providerSmokeTest({
      url: 'https://chatgpt.com/',
      network: 'egress',
      env: {},
      timeoutSeconds: 5,
      images: IMAGES,
    });

    expect(imagesRun()).toEqual([IMAGES.agent.reference]);
  });

  it('runs the agent from the agent reference', async () => {
    await runCodexAgent({
      prompt: 'implement it',
      network: 'egress',
      env: {},
      mounts: [],
      timeoutSeconds: 5,
      graceSeconds: 1,
      artifactDir: join(dir, 'artifacts'),
      images: IMAGES,
    });

    expect(imagesRun()).toEqual([IMAGES.agent.reference]);
  });

  it('never reaches a container-owning module through a mutable build tag', async () => {
    const store = new ArtifactStore(join(dir, 'snapshots'));

    await createWorkspaceVolume('attempt-2', Buffer.from('tar'), IMAGES);
    await initSyntheticGit('ai-harness-ws-attempt-2', IMAGES);
    await snapshotWorkspace('ai-harness-ws-attempt-2', store, IMAGES);
    await createDependencyVolume('attempt-2', 'agent', Buffer.alloc(0), IMAGES);
    await startProxyContainer({
      attempt: 'attempt-2',
      egressNetwork: 'egress',
      outwardNetwork: 'outward',
      images: IMAGES,
    });
    await providerSmokeTest({
      url: 'https://chatgpt.com/',
      network: 'egress',
      env: {},
      timeoutSeconds: 5,
      images: IMAGES,
    });
    await runCodexAgent({
      prompt: 'implement it',
      network: 'egress',
      env: {},
      mounts: [],
      timeoutSeconds: 5,
      graceSeconds: 1,
      artifactDir: join(dir, 'artifacts'),
      images: IMAGES,
    });
    await runVerification({
      attempt: 'attempt-2',
      snapshot: await storedArtifact(),
      dependencySnapshot: Buffer.alloc(0),
      commands: [['npx', 'vitest', 'run']],
      artifactDir: join(dir, 'artifacts'),
      images: IMAGES,
    });

    const argv = calls.flat();
    for (const tag of TAGS) expect(argv).not.toContain(tag);

    expect(imagesRun().length).toBeGreaterThan(0);
    for (const image of imagesRun()) expect(REFERENCES).toContain(image);
  });
});

describe('runtimeSection', () => {
  it('is built from the executed RuntimeImages value', () => {
    expect(runtimeSection(IMAGES)).toEqual({
      harness_version: expect.any(String),
      agent_image_digest: IMAGES.agent.digest,
      verifier_image_digest: IMAGES.verifier.digest,
      setup_image_digest: IMAGES.setup.digest,
      proxy_image_digest: IMAGES.proxy.digest,
    });
  });

  it('records content digests, not the runnable references', () => {
    const recorded = JSON.stringify(runtimeSection(IMAGES));

    for (const role of IMAGE_ROLES) {
      expect(recorded).toContain(IMAGES[role].digest);
      expect(recorded).not.toContain(IMAGES[role].reference);
    }
  });
});
