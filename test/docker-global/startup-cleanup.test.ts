import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import type { RuntimeImage, RuntimeImages } from '../../src/docker/images.js';
import { sweepHarness } from '../../src/run/cleanup.js';
import { runSinglePlanStep } from '../../src/run/bridge.js';
import { ATTEMPT_LABEL, ROLE_LABEL } from '../../src/volume/naming.js';
import { runtimeImages } from '../helpers/images.js';
import { createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { planDocument } from '../helpers/plan.js';
import { cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

/**
 * This suite sweeps every harness-labelled resource on the daemon, so it runs in its own
 * project, alone. Inside the parallel `docker` project it would delete another file's
 * containers mid-run — which is precisely why `runSinglePlanStep` itself never sweeps globally.
 */

/** The implementation the fixture's own test suite accepts, so the run reaches a commit. */
const SLUGIFY = `export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

let repo: TargetRepo;
let root: string;
let planFile: string;
let stub: RuntimeImage;
let images: RuntimeImages;
const dirs: string[] = [];

beforeAll(async () => {
  images = await runtimeImages();
  stub = await stubAgentImage();

  repo = await createTargetRepo();
  root = await mkdtemp(join(tmpdir(), 'harness-startup-'));

  const source = join(root, 'codex-source');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, AUTH_FILE),
    JSON.stringify({ tokens: { access_token: 'sk-startup-canary' } }),
  );

  planFile = join(root, 'plan.yml');
  await writeFile(
    planFile,
    planDocument([
        'type: task',
        'complexity: low',
        'id: add-slugify',
        'observable_behavior: Implement the slugify function in src/slugify.js',
        'implementation_paths:',
        '  - src/slugify.js',
        'verification:',
        '  commands:',
        '    - ["npx", "--no-install", "vitest", "run", "--config", "vitest.config.js"]',
        'timeouts:',
        '  connectivity_smoke_seconds: 20',
        '  agent_seconds: 30',
        '  termination_grace_seconds: 2',
    ]),
  );
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function labelled(kind: 'container' | 'volume' | 'network', attempt?: string) {
  const filter = attempt === undefined ? `label=${ATTEMPT_LABEL}` : `label=${ATTEMPT_LABEL}=${attempt}`;
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', filter]
      : [kind, 'ls', '-q', '--filter', filter];

  const { stdout } = await execa('docker', args);
  return stdout.split('\n').filter((line) => line !== '');
}

/** What a run killed outright leaves behind: labelled resources nobody owns any more. */
async function leaveStaleResources(attempt: string): Promise<void> {
  const labels = ['--label', `${ATTEMPT_LABEL}=${attempt}`, '--label', `${ROLE_LABEL}=stale`];

  await execa('docker', ['run', '-d', ...labels, images.setup.id, 'sleep', '300']);
  await execa('docker', ['volume', 'create', ...labels, `ai-harness-ws-${attempt}`]);
  await execa('docker', ['network', 'create', ...labels, `ai-harness-net-${attempt}-egress`]);
}

describe('a production restart cleans up after a crashed one', () => {
  it('removes the containers, volumes and networks a previous attempt left behind', async () => {
    const stale = `stale${String(Date.now()).slice(-10)}`;
    await leaveStaleResources(stale);

    await expect(labelled('container', stale)).resolves.not.toEqual([]);
    await expect(labelled('volume', stale)).resolves.not.toEqual([]);
    await expect(labelled('network', stale)).resolves.not.toEqual([]);

    // The attempt id is unknown to a restarted process, so the sweep is by label alone.
    await sweepHarness();

    await expect(labelled('container', stale)).resolves.toEqual([]);
    await expect(labelled('volume', stale)).resolves.toEqual([]);
    await expect(labelled('network', stale)).resolves.toEqual([]);
    await expect(labelled('container')).resolves.toEqual([]);
    await expect(labelled('volume')).resolves.toEqual([]);
    await expect(labelled('network')).resolves.toEqual([]);
  }, 300_000);

  it('leaves an ordinary run untouched, and that run leaks nothing of its own', async () => {
    const foreign = `foreign${String(Date.now()).slice(-10)}`;
    await leaveStaleResources(foreign);

    const artifacts = await mkdtemp(join(tmpdir(), 'harness-artifacts-'));
    dirs.push(artifacts);

    const report = await runSinglePlanStep({
      planFile,
      repoPath: repo.dir,
      artifactDir: artifacts,
      sourceCodexHome: join(root, 'codex-source'),
      storeDirectory: join(root, 'store'),
      dependencyCacheDirectory: join(root, 'deps'),
      injection: {
        codex: stub,
        agentEnv: {
          STUB_MODE: 'write',
          STUB_EVENTS: cannedEvents(),
          STUB_WRITE_PATH: 'src/slugify.js',
          STUB_WRITE_CONTENT: SLUGIFY,
        },
      },
    });

    expect(report.status).toBe('succeeded');

    // Its own attempt is fully released...
    await expect(labelled('container', report.attempt)).resolves.toEqual([]);
    await expect(labelled('volume', report.attempt)).resolves.toEqual([]);
    await expect(labelled('network', report.attempt)).resolves.toEqual([]);

    // ...and the resources belonging to another attempt are still there, because `runSinglePlanStep`
    // owns its attempt and nothing else.
    await expect(labelled('container', foreign)).resolves.not.toEqual([]);
    await expect(labelled('volume', foreign)).resolves.not.toEqual([]);
    await expect(labelled('network', foreign)).resolves.not.toEqual([]);

    await sweepHarness();
  }, 900_000);
});
