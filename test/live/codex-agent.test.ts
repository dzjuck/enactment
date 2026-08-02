import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compileCodexPolicy } from '../../src/adapters/codex/policy.js';
import { runCodexAgent } from '../../src/adapters/codex/run.js';
import { readAuthStore, seedAuthStore } from '../../src/auth/store.js';
import { authMount, copyBackAuth, createAuthVolume } from '../../src/auth/volume.js';
import { IMAGE_PINS, PROVIDER_ALLOWLIST } from '../../src/config/pins.js';
import { DependencyCache, ensureDependencySnapshot } from '../../src/deps/setup.js';
import { createDependencyVolume, dependencyMount } from '../../src/deps/volume.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { runContainer } from '../../src/docker/run.js';
import { exportCommit } from '../../src/git/export.js';
import { withPhaseNetworks } from '../../src/net/manage.js';
import { proxyEnvironment, withProxy } from '../../src/proxy/container.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { initSyntheticGit } from '../../src/volume/synthetic-git.js';
import { createWorkspaceVolume, removeVolume, workspaceMount } from '../../src/volume/workspace.js';
import { runtimeImages } from '../helpers/images.js';
import { createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';

const PROMPT =
  'Implement the slugify function in src/slugify.js so that test/slugify.test.js passes. ' +
  'Lowercase the title, drop punctuation, and join words with single hyphens with no ' +
  'leading or trailing hyphen. Edit only src/slugify.js.';

let repo: TargetRepo;
let tar: Buffer;
let deps: Buffer;
let root: string;
let authVolume: string;
let authStore: Awaited<ReturnType<typeof seedAuthStore>>;
let images: RuntimeImages;

beforeAll(async () => {
  images = await runtimeImages();
  repo = await createTargetRepo();
  ({ tar } = await exportCommit(repo.dir, repo.commit));

  root = await mkdtemp(join(tmpdir(), 'harness-live-'));
  const cache = new DependencyCache(join(root, 'deps'));
  await ensureDependencySnapshot({
    cache,
    key: 'sha256:live-agent',
    attempt: newAttemptId(),
    workspaceTar: tar,
    installCommand: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    network: 'bridge',
    images,
  });
  deps = await cache.read('sha256:live-agent');

  authStore = await seedAuthStore(join(root, 'store'));
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

/**
 * §35 regression: Codex's inner sandbox is disabled. Bubblewrap aborts under the hardened
 * profile, so a real run that completes is what demonstrates the bypass works end to end.
 */
describe('real Codex agent run', () => {
  it('completes the fixture task and modifies files under /workspace', async () => {
    const attempt = newAttemptId();
    const workspace = await createWorkspaceVolume(attempt, tar, images);
    const depsVolume = await createDependencyVolume(attempt, 'agent', deps, images);
    const artifacts = join(root, 'artifacts');

    await initSyntheticGit(workspace, images);
    const policy = compileCodexPolicy({ prompt: PROMPT, workdir: '/workspace' });

    authVolume = await createAuthVolume(
      attempt,
      { auth: await readAuthStore(authStore), policy: policy.files },
      images,
    );

    try {
      const before = await runContainer({
        image: IMAGE_PINS.agent.tag,
        argv: ['cat', '/workspace/src/slugify.js'],
        network: 'none',
        mounts: [workspaceMount(workspace)],
      });

      const result = await withPhaseNetworks(attempt, 'agent', async (networks) =>
        withProxy(
          {
            attempt,
            egressNetwork: networks.egress ?? '',
            outwardNetwork: networks['proxy-egress'] ?? '',
            allowlist: PROVIDER_ALLOWLIST,
            ports: [443],
            images,
          },
          async (handle) => {
            const run = await runCodexAgent({
              prompt: PROMPT,
              policy,
              network: networks.egress ?? '',
              env: proxyEnvironment(handle),
              mounts: [
                workspaceMount(workspace),
                dependencyMount(depsVolume),
                authMount(authVolume),
              ],
              timeoutSeconds: 1200,
              graceSeconds: 10,
              artifactDir: artifacts,
              images,
            });

            const records = await handle.records();
            expect(records.some((record) => record.allowed)).toBe(true);
            expect(records.filter((r) => r.allowed).every((r) => r.hostname === 'chatgpt.com')).toBe(
              true,
            );

            return run;
          },
        ),
      );

      expect(result.status).toBe('completed');
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.usage.output_tokens).toBeGreaterThan(0);

      const after = await runContainer({
        image: IMAGE_PINS.agent.tag,
        argv: ['cat', '/workspace/src/slugify.js'],
        network: 'none',
        mounts: [workspaceMount(workspace)],
      });

      expect(after.stdout).not.toBe(before.stdout);
      expect(after.stdout).not.toContain('not implemented');
    } finally {
      // Rotation is taken back before the volume goes, exactly as a run would.
      await copyBackAuth(authVolume, authStore, images).catch(() => undefined);
      await removeVolume(authVolume);
      await removeVolume(workspace);
      await removeVolume(depsVolume);
    }
  }, 1_800_000);
});
