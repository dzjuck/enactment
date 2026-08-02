import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ArtifactStore, type StoredArtifact } from '../../src/artifacts/store.js';
import { DependencyCache, ensureDependencySnapshot } from '../../src/deps/setup.js';
import { createDependencyVolume, dependencyMount } from '../../src/deps/volume.js';
import { sourceDiff } from '../../src/diff/source-diff.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { runContainer } from '../../src/docker/run.js';
import { IMAGE_PINS } from '../../src/config/pins.js';
import { exportCommit } from '../../src/git/export.js';
import {
  runVerification,
  VERIFICATION_ARTIFACT,
  type VerificationResult,
} from '../../src/verify/run.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { dependencyVolumeName, workspaceVolumeName } from '../../src/volume/naming.js';
import { volumeExists } from '../../src/volume/workspace.js';
import { runtimeImages } from '../helpers/images.js';
import { commitAll, createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';

const SLUGIFY = `export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

const VITEST = ['npx', '--no-install', 'vitest', 'run', '--config', 'vitest.config.js'];

let repo: TargetRepo;
let store: ArtifactStore;
let root: string;
let deps: Buffer;
let passing: StoredArtifact;
let failing: StoredArtifact;
let images: RuntimeImages;

beforeAll(async () => {
  images = await runtimeImages();
  repo = await createTargetRepo();
  root = await mkdtemp(join(tmpdir(), 'harness-verify-'));
  store = new ArtifactStore(join(root, 'artifacts'));

  const { tar: original } = await exportCommit(repo.dir, repo.commit);
  failing = await store.put(original);

  await writeFile(join(repo.dir, 'src/slugify.js'), SLUGIFY);
  const implemented = await commitAll(repo.dir, 'Implement slugify');
  const { tar: done } = await exportCommit(repo.dir, implemented);
  passing = await store.put(done);

  const cache = new DependencyCache(join(root, 'deps'));
  await ensureDependencySnapshot({
    cache,
    key: 'sha256:verification-tests',
    attempt: newAttemptId(),
    workspaceTar: original,
    installCommand: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    network: 'bridge',
    images,
  });
  deps = await cache.read('sha256:verification-tests');
}, 600_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

async function verify(
  snapshot: StoredArtifact,
  commands: readonly (readonly string[])[],
  overrides: Partial<Parameters<typeof runVerification>[0]> = {},
) {
  const artifactDir = await mkdtemp(join(tmpdir(), 'harness-verify-artifacts-'));

  const result = await runVerification({
    attempt: newAttemptId(),
    snapshot,
    dependencySnapshot: deps,
    commands,
    artifactDir,
    images,
    timeoutSeconds: 120,
    graceSeconds: 2,
    ...overrides,
  });

  return { result, artifactDir };
}

describe('verification phase', () => {
  it('passes the fixture suite when the implementation is complete', async () => {
    const { result } = await verify(passing, [VITEST]);

    expect(result.status).toBe('pass');
    expect(result.commands[0]?.exitCode).toBe(0);
  }, 300_000);

  it('fails, with exit code and output, when the suite fails', async () => {
    const { result } = await verify(failing, [VITEST]);

    expect(result.status).toBe('fail');
    expect(result.commands[0]?.exitCode).not.toBe(0);
    expect(`${result.commands[0]?.stdout ?? ''}${result.commands[0]?.stderr ?? ''}`).toContain(
      'slugify',
    );
  }, 300_000);

  it('runs offline, with only loopback', async () => {
    const { result } = await verify(passing, [
      ['sh', '-c', 'ls /sys/class/net | sort | tr "\\n" ","'],
    ]);

    expect(result.commands[0]?.stdout.trim()).toBe('lo,');
  }, 300_000);

  it('has no provider auth mount and no provider auth variable', async () => {
    const { result } = await verify(passing, [
      [
        'sh',
        '-c',
        'test -e /run/agent-auth && echo AUTH_PRESENT || echo NO_AUTH; env | grep -icE "codex|openai|api_key" || true',
      ],
    ]);

    expect(result.commands[0]?.stdout).toContain('NO_AUTH');
    expect(result.commands[0]?.stdout.trim().endsWith('0')).toBe(true);
  }, 300_000);

  it('uses a fresh dependency volume, never the agent one', async () => {
    const attempt = newAttemptId();
    const agentDeps = await createDependencyVolume(attempt, 'agent', deps, images);

    try {
      await runContainer({
        image: IMAGE_PINS.verifier.tag,
        argv: ['sh', '-c', 'touch /workspace/node_modules/.agent-only'],
        network: 'none',
        mounts: [dependencyMount(agentDeps)],
      });

      const { result } = await verify(
        passing,
        [['sh', '-c', 'test -e node_modules/.agent-only && echo LEAKED || echo FRESH']],
        { attempt },
      );

      expect(result.commands[0]?.stdout).toContain('FRESH');
    } finally {
      await runContainer({
        image: IMAGE_PINS.verifier.tag,
        argv: ['true'],
        network: 'none',
      });
      const { removeVolume } = await import('../../src/volume/workspace.js');
      await removeVolume(agentDeps);
    }
  }, 300_000);

  it('cannot alter the implementation snapshot from inside the verifier', async () => {
    const before = await store.read(passing.hash);

    const { result } = await verify(passing, [
      ['sh', '-c', 'echo tampered > src/slugify.js && touch VERIFIER_WROTE'],
    ]);

    expect(result.status).toBe('pass');
    expect((await store.read(passing.hash)).equals(before)).toBe(true);

    const { tar: original } = await exportCommit(repo.dir, repo.commit);
    const changes = await sourceDiff(original, await store.read(passing.hash));
    const paths = changes.map(
      (change) => change.path,
    );
    expect(paths).not.toContain('VERIFIER_WROTE');
  }, 300_000);

  it('destroys the disposable workspace copy afterwards', async () => {
    const { result } = await verify(passing, [['true']]);

    expect(result.workspaceVolume).toMatch(/^ai-harness-/);
    await expect(volumeExists(result.workspaceVolume)).resolves.toBe(false);
  }, 300_000);

  it('passes commands as fixed argv arrays, never through a shell', async () => {
    const { result } = await verify(passing, [
      [
        'node',
        '-e',
        'console.log(process.argv.slice(1).join("|"))',
        'a;whoami',
        '$(id -u)',
        '&& rm -rf /',
        '`echo hi`',
      ],
    ]);

    expect(result.commands[0]?.stdout.trim()).toBe('a;whoami|$(id -u)|&& rm -rf /|`echo hi`');
  }, 300_000);

  it('kills a hanging verification command at its timeout', async () => {
    const { result } = await verify(passing, [['sh', '-c', 'trap "" TERM; sleep 300']], {
      timeoutSeconds: 3,
      graceSeconds: 2,
    });

    expect(result.status).toBe('timeout');
    expect(result.commands[0]?.status).toBe('timeout');
  }, 300_000);

  it('stores the verification result as an artifact', async () => {
    const { artifactDir } = await verify(passing, [['true']]);

    const stored = JSON.parse(
      await readFile(join(artifactDir, VERIFICATION_ARTIFACT), 'utf8'),
    ) as VerificationResult;

    expect(stored.status).toBe('pass');
    expect(stored.commands[0]?.argv).toEqual(['true']);
  }, 300_000);
});

describe('verifier acquisition is transactional', () => {
  /** The two volumes a verification acquires, named the way `runVerification` names them. */
  function volumesFor(attempt: string): { workspace: string; dependencies: string } {
    return {
      workspace: workspaceVolumeName(`${attempt}-verify`),
      dependencies: dependencyVolumeName(`${attempt}-verify`, 'verifier'),
    };
  }

  async function expectBothGone(attempt: string): Promise<void> {
    const { workspace, dependencies } = volumesFor(attempt);
    await expect(volumeExists(workspace)).resolves.toBe(false);
    await expect(volumeExists(dependencies)).resolves.toBe(false);
  }

  it('removes the workspace volume when the dependency volume cannot be created', async () => {
    const attempt = newAttemptId();

    await expect(
      verify(passing, [VITEST], {
        attempt,
        createDependencies: () => Promise.reject(new Error('injected dependency failure')),
      }),
    ).rejects.toThrow('injected dependency failure');

    await expectBothGone(attempt);
  }, 300_000);

  it('removes both volumes when restore fails after acquiring them', async () => {
    const attempt = newAttemptId();

    await expect(
      verify(passing, [VITEST], {
        attempt,
        restore: () => Promise.reject(new Error('injected restore failure')),
      }),
    ).rejects.toThrow('injected restore failure');

    await expectBothGone(attempt);
  }, 300_000);

  it('removes both volumes when a verification command fails', async () => {
    const attempt = newAttemptId();

    const { result } = await verify(failing, [VITEST], { attempt });

    expect(result.status).toBe('fail');
    await expectBothGone(attempt);
  }, 300_000);

  it('removes both volumes when a verification command times out', async () => {
    const attempt = newAttemptId();

    const { result } = await verify(passing, [['sleep', '120']], {
      attempt,
      timeoutSeconds: 3,
      graceSeconds: 1,
    });

    expect(result.status).toBe('timeout');
    await expectBothGone(attempt);
  }, 300_000);
});
