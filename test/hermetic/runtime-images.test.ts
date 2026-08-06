import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCodexAgent } from '../../src/adapters/codex/run.js';
import { providerSmokeTest } from '../../src/adapters/codex/smoke.js';
import { CLAUDE_AUTH_PATH } from '../../src/adapters/claude/policy.js';
import { CODEX_HOME_PATH } from '../../src/adapters/codex/policy.js';
import { ArtifactStore, type StoredArtifact } from '../../src/artifacts/store.js';
import {
  AGENT_GID,
  AGENT_UID,
  CLAUDE_VERSION,
  CODEX_VERSION,
  IMAGE_PINS,
  IMAGE_ROLES,
  NODE_BASE_IMAGE,
  SEMGREP_IMAGE,
  SEMGREP_VERSION,
  type ImageRole,
} from '../../src/config/pins.js';
import { DependencyCache, ensureDependencySnapshot } from '../../src/deps/setup.js';
import { createDependencyVolume } from '../../src/deps/volume.js';
import {
  buildImage,
  resolveRuntimeImages,
  RuntimeImageError,
  type RuntimeImages,
} from '../../src/docker/images.js';
import { startProxyContainer } from '../../src/proxy/container.js';
import { runtimeSection } from '../../src/run/manifest.js';
import { runVerification } from '../../src/verify/run.js';
import { restoreWorkspace, snapshotWorkspace } from '../../src/volume/snapshot.js';
import { initSyntheticGit } from '../../src/volume/synthetic-git.js';
import { createWorkspaceVolume } from '../../src/volume/workspace.js';

/**
 * Container execution is recorded rather than performed, so this suite can prove which image
 * every phase actually ran — the claim Step 22 exists to make — without a daemon.
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
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The image IDs the daemon would report. This is the only runtime identity there is. */
const IDS = Object.fromEntries(
  IMAGE_ROLES.map((role, index) => [role, digits(index + 1)]),
) as Record<ImageRole, string>;

const IMAGES = Object.fromEntries(
  IMAGE_ROLES.map((role) => [role, { role, id: IDS[role] }]),
) as RuntimeImages;

const TAGS = IMAGE_ROLES.map((role) => IMAGE_PINS[role].tag);

/** The image each recorded `docker run` was given: `buildRunArgs` puts it after every flag. */
function imagesRun(): string[] {
  return calls
    .filter((args) => args[0] === 'run')
    .map((args) => args.find((arg) => arg.startsWith('sha256:')) ?? '<none>');
}

/** Records every docker invocation, so a test can prove what was never attempted. */
function recordingExec(inspect: (tag: string) => Promise<string>) {
  const invocations: string[][] = [];

  const exec = async (args: string[]): Promise<string> => {
    invocations.push(args);
    return await inspect(args.at(-1) ?? '');
  };

  const containerCommands = (): string[][] =>
    invocations.filter((args) => ['run', 'create', 'start'].includes(args[0] ?? ''));

  return { invocations, exec, containerCommands };
}

const idOf = (tag: string): string => {
  const role = IMAGE_ROLES.find((candidate) => tag.includes(candidate));
  if (role === undefined) throw new Error(`unexpected image reference: ${tag}`);
  return IDS[role];
};

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

describe('runtime image resolution', () => {
  it('exposes the exact six runtime image roles without an agent alias', () => {
    expect(IMAGE_ROLES).toEqual(['codex', 'claude', 'verifier', 'reviewer', 'setup', 'proxy']);
    expect(IMAGE_PINS).not.toHaveProperty('agent');
  });

  it('inspects each role once and returns its immutable Docker image ID', async () => {
    const { invocations, exec } = recordingExec((tag) => Promise.resolve(idOf(tag)));

    const images = await resolveRuntimeImages({ exec });

    for (const role of IMAGE_ROLES) {
      expect(images[role]).toEqual({ role, id: IDS[role] });
    }

    // One inspection per role, and nothing else: no platform query, no second identity.
    expect(invocations).toEqual(
      IMAGE_ROLES.map((role) => [
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        IMAGE_PINS[role].tag,
      ]),
    );
  });

  it('fails on a missing local image, naming the tag and the build command', async () => {
    const { exec, containerCommands } = recordingExec((tag) =>
      tag.includes('verifier')
        ? Promise.reject(new Error(`Error: No such image: ${tag}`))
        : Promise.resolve(idOf(tag)),
    );

    const error = await resolveRuntimeImages({ exec }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RuntimeImageError);
    expect((error as Error).message).toContain(IMAGE_PINS.verifier.tag);
    expect((error as Error).message).toContain('npm run images:build');
    expect(containerCommands()).toEqual([]);
  });
});

describe('image build arguments', () => {
  it('builds each role from the pinned base image and the fixed agent identity', async () => {
    for (const role of IMAGE_ROLES) {
      const { invocations, exec } = recordingExec(() => Promise.resolve(''));

      await buildImage(role, exec);

      const argv = (invocations[0] ?? []).join(' ');
      // The reviewer is the one role that is not a Node image: it is the pinned scanner.
      expect(argv).toContain(
        role === 'reviewer' ? `SEMGREP_IMAGE=${SEMGREP_IMAGE}` : `BASE_IMAGE=${NODE_BASE_IMAGE}`,
      );
      expect(argv).toContain(`AGENT_UID=${String(AGENT_UID)}`);
      expect(argv).toContain(`AGENT_GID=${String(AGENT_GID)}`);
      expect(argv).toContain(`--tag ${IMAGE_PINS[role].tag}`);
    }
  });

  it('builds the reviewer image from an immutable scanner digest, never a floating tag', async () => {
    const { invocations, exec } = recordingExec(() => Promise.resolve(''));

    await buildImage('reviewer', exec);

    expect(SEMGREP_IMAGE).toContain(`:${SEMGREP_VERSION}@sha256:`);
    expect((invocations[0] ?? []).join(' ')).toContain(`SEMGREP_IMAGE=${SEMGREP_IMAGE}`);
  });

  it('builds the Codex image with the pinned Codex version', async () => {
    const { invocations, exec } = recordingExec(() => Promise.resolve(''));

    await buildImage('codex', exec);

    expect((invocations[0] ?? []).join(' ')).toContain(`CODEX_VERSION=${CODEX_VERSION}`);
  });

  it('builds the Claude image with the pinned Claude Code version', async () => {
    const { invocations, exec } = recordingExec(() => Promise.resolve(''));

    await buildImage('claude', exec);

    expect((invocations[0] ?? []).join(' ')).toContain(`CLAUDE_VERSION=${CLAUDE_VERSION}`);
  });

  it('creates both provider auth mount points with the numeric agent identity', async () => {
    for (const [role, path] of [
      ['codex', CODEX_HOME_PATH],
      ['claude', CLAUDE_AUTH_PATH],
    ] as const) {
      const dockerfile = await readFile(
        join(REPO_ROOT, IMAGE_PINS[role].context, 'Dockerfile'),
        'utf8',
      );

      expect(dockerfile).toContain(`mkdir -p ${path}`);
      expect(dockerfile).toContain(`chown "\${AGENT_UID}:\${AGENT_GID}" ${path}`);
      expect(dockerfile).toContain(`chmod 0700 ${path}`);
    }
  });
});

describe('phases execute the supplied runtime image set', () => {
  it('seeds the workspace volume with the setup image', async () => {
    await createWorkspaceVolume('attempt-1', Buffer.from('tar'), IMAGES);

    expect(imagesRun()).toEqual([IMAGES.setup.id]);
  });

  it('initializes synthetic git with the agent image', async () => {
    await initSyntheticGit('ai-harness-ws-attempt-1', IMAGES);

    expect(imagesRun()).toEqual([IMAGES.codex.id]);
  });

  it('snapshots and restores the workspace with the setup image', async () => {
    const store = new ArtifactStore(join(dir, 'snapshots'));
    await snapshotWorkspace('ai-harness-ws-attempt-1', store, IMAGES);
    await restoreWorkspace('ai-harness-ws-attempt-1', await storedArtifact(), IMAGES);

    expect(imagesRun()).toEqual([IMAGES.setup.id, IMAGES.setup.id]);
  });

  it('seeds a dependency volume with the setup image', async () => {
    await createDependencyVolume('attempt-1', 'agent', Buffer.alloc(0), IMAGES);

    expect(imagesRun()).toEqual([IMAGES.setup.id]);
  });

  it('installs dependencies with the setup image', async () => {
    await ensureDependencySnapshot({
      cache: new DependencyCache(join(dir, 'deps')),
      key: 'sha256:cold',
      attempt: 'attempt-1',
      workspaceTar: Buffer.from('tar'),
      installCommand: ['npm', 'ci', '--ignore-scripts'],
      network: 'ai-harness-net-attempt-1-registry',
      images: IMAGES,
    });

    expect(new Set(imagesRun())).toEqual(new Set([IMAGES.setup.id]));
  });

  it('runs verification with the verifier image', async () => {
    await runVerification({
      attempt: 'attempt-1',
      snapshot: await storedArtifact(),
      dependencySnapshot: Buffer.alloc(0),
      commands: [['npx', 'vitest', 'run']],
      artifactDir: join(dir, 'artifacts'),
      images: IMAGES,
    });

    // The disposable copy is seeded by setup containers; the commands are the verifier's.
    expect(imagesRun()).toContain(IMAGES.verifier.id);
    expect(new Set(imagesRun())).toEqual(new Set([IMAGES.setup.id, IMAGES.verifier.id]));
  });

  it('starts the proxy from the proxy image', async () => {
    await startProxyContainer({
      attempt: 'attempt-1',
      egressNetwork: 'egress',
      outwardNetwork: 'outward',
      images: IMAGES,
      // This suite asserts which image each phase runs, not how readiness is detected;
      // `waitUntilListening` has its own suite in `proxy-readiness.test.ts`.
      waitReady: () => Promise.resolve(),
    });

    expect(imagesRun()).toEqual([IMAGES.proxy.id]);
  });

  it('runs the Codex connectivity smoke test from the Codex image', async () => {
    await providerSmokeTest({
      url: 'https://chatgpt.com/',
      network: 'egress',
      env: {},
      timeoutSeconds: 5,
      images: IMAGES,
    });

    expect(imagesRun()).toEqual([IMAGES.codex.id]);
  });

  it('runs Codex from the Codex image', async () => {
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

    expect(imagesRun()).toEqual([IMAGES.codex.id]);
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
      waitReady: () => Promise.resolve(),
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
    for (const image of imagesRun()) expect(Object.values(IDS)).toContain(image);
  });
});

describe('runtimeSection', () => {
  it('records exactly the six executed image IDs', () => {
    expect(runtimeSection(IMAGES)).toEqual({
      harness_version: expect.any(String),
      codex_image_id: IDS.codex,
      claude_image_id: IDS.claude,
      verifier_image_id: IDS.verifier,
      reviewer_image_id: IDS.reviewer,
      setup_image_id: IDS.setup,
      proxy_image_id: IDS.proxy,
    });
  });

  it('records no mutable tag', () => {
    const recorded = JSON.stringify(runtimeSection(IMAGES));

    for (const tag of TAGS) expect(recorded).not.toContain(tag);
  });

  it('contains no obsolete ambiguous agent image field', () => {
    expect(runtimeSection(IMAGES)).not.toHaveProperty('agent_image_id');
  });
});
