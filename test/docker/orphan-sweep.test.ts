import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import type { RuntimeImage } from '../../src/docker/images.js';
import { sweepAttempt } from '../../src/run/cleanup.js';
import { ATTEMPT_LABEL } from '../../src/volume/naming.js';
import { createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { planDocument } from '../helpers/plan.js';
import { cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

const SLUGIFY = 'export function slugify(t) {\n  return String(t).toLowerCase();\n}\n';

let repo: TargetRepo;
let root: string;
let runnerScript: string;
let stub: RuntimeImage;

beforeAll(async () => {
  stub = await stubAgentImage();

  repo = await createTargetRepo();
  root = await mkdtemp(join(tmpdir(), 'harness-orphan-'));

  const source = join(root, 'codex-source');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, AUTH_FILE),
    JSON.stringify({ tokens: { access_token: 'sk-orphan-canary' } }),
  );

  await writeFile(
    join(root, 'plan.yml'),
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
        '  agent_seconds: 120',
        '  termination_grace_seconds: 2',
    ]),
  );

  runnerScript = join(root, 'runner.mjs');
  await writeFile(
    runnerScript,
    [
      "import { appendFile } from 'node:fs/promises';",
      `import { runSinglePlanStep } from ${JSON.stringify(join(process.cwd(), 'dist/run/bridge.js'))};`,
      'await runSinglePlanStep({',
      '  ...JSON.parse(process.env.HARNESS_TEST_RUN),',
      '  onPhase: (phase) => appendFile(process.env.HARNESS_TEST_PHASES, `${phase}\\n`),',
      '});',
      '',
    ].join('\n'),
  );
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

/** Wait until the set of labelled resources stops changing, so stragglers are counted. */
async function settled(attempt: string): Promise<void> {
  let previous = '';

  for (let poll = 0; poll < 40; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));

    const current = (
      await Promise.all(
        (['container', 'volume', 'network'] as const).map((kind) => labelled(kind, attempt)),
      )
    )
      .flat()
      .sort()
      .join(',');

    if (current !== '' && current === previous) return;
    previous = current;
  }
}

async function labelled(
  kind: 'container' | 'volume' | 'network',
  attempt: string,
): Promise<string[]> {
  const filter = `label=${ATTEMPT_LABEL}=${attempt}`;
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', filter]
      : [kind, 'ls', '-q', '--filter', filter];

  const { stdout } = await execa('docker', args);
  return stdout.split('\n').filter((line) => line !== '');
}

describe('orphans left by a run that was killed outright', () => {
  /**
   * SIGKILL, not SIGINT: the graceful path already has a test. This is the case the
   * attempt-label sweep exists for — no teardown ran at all, `--rm` does not apply to a
   * container that is still running, and the only thing that can find what survived is the
   * label. A container started without one is invisible to the backstop.
   */
  it('labels every container it starts, so the sweep can find them', async () => {
    const attempt = `orphan${String(Date.now()).slice(-10)}`;
    const artifacts = await mkdtemp(join(tmpdir(), 'harness-artifacts-'));
    const phasesFile = join(root, 'phases');
    await writeFile(phasesFile, '');

    const child = execa('node', [runnerScript], {
      reject: false,
      env: {
        HARNESS_TEST_PHASES: phasesFile,
        HARNESS_TEST_RUN: JSON.stringify({
          planFile: join(root, 'plan.yml'),
          repoPath: repo.dir,
          artifactDir: artifacts,
          sourceCodexHome: join(root, 'codex-source'),
          storeDirectory: join(root, 'store'),
          dependencyCacheDirectory: join(root, 'deps'),
          injection: {
            attempt,
            agent: stub,
            // Hangs, so the agent container is alive when the run is killed.
            agentEnv: {
              STUB_MODE: 'hang',
              STUB_EVENTS: cannedEvents(),
              STUB_WRITE_PATH: 'src/slugify.js',
              STUB_WRITE_CONTENT: SLUGIFY,
            },
          },
        }),
      },
    });

    try {
      for (let poll = 0; poll < 900; poll += 1) {
        if ((await readFile(phasesFile, 'utf8')).includes('agent')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Give the agent container time to actually start.
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      child.kill('SIGKILL');
      await child;

      // SIGKILL does not reach the `docker` CLI processes the run had already spawned, so a
      // straggler can still be creating a resource. Let them finish before taking stock.
      await settled(attempt);

      // The agent container outlived the run: --rm does not apply to a running container and
      // no teardown got to execute. Without a label the sweep could not see it at all.
      await expect(labelled('container', attempt)).resolves.not.toEqual([]);
      await expect(labelled('volume', attempt)).resolves.not.toEqual([]);

      await sweepAttempt(attempt);

      await expect(labelled('container', attempt)).resolves.toEqual([]);
      await expect(labelled('volume', attempt)).resolves.toEqual([]);
      await expect(labelled('network', attempt)).resolves.toEqual([]);
    } finally {
      await rm(artifacts, { recursive: true, force: true });
      // Whatever the assertions did, this test must not leave the daemon dirty.
      // Retried: a straggler that lands after the sweep would otherwise leak into the next
      // test, and this suite asserts a clean daemon.
      for (let pass = 0; pass < 10; pass += 1) {
        const survivors = await labelled('container', attempt);
        if (survivors.length > 0) {
          await execa('docker', ['rm', '--force', ...survivors], { reject: false });
        }
        for (const kind of ['volume', 'network'] as const) {
          const rest = await labelled(kind, attempt);
          if (rest.length > 0) await execa('docker', [kind, 'rm', ...rest], { reject: false });
        }

        const remaining = await Promise.all(
          (['container', 'volume', 'network'] as const).map((kind) => labelled(kind, attempt)),
        );
        if (remaining.every((list) => list.length === 0)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }, 300_000);
});
