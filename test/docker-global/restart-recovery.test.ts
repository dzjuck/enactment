import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import type { RuntimeImage } from '../../src/docker/images.js';
import { ATTEMPT_LABEL } from '../../src/volume/naming.js';
import { createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

/**
 * The restart-recovery path, end to end and for real: a run is killed outright, its resources
 * survive because no teardown ran, and the next production CLI start removes them.
 *
 * The killed run is stub-driven, and the CLI that follows is pointed at a repository that does
 * not exist so it fails in the export phase — after the startup sweep, before any container.
 * That keeps the whole check free of provider tokens while still exercising the real binary.
 */

const SLUGIFY = 'export function slugify(t) {\n  return String(t).toLowerCase();\n}\n';

let repo: TargetRepo;
let root: string;
let taskFile: string;
let runnerScript: string;
let stub: RuntimeImage;

beforeAll(async () => {
  stub = await stubAgentImage();
  repo = await createTargetRepo();
  root = await mkdtemp(join(tmpdir(), 'harness-restart-'));

  const source = join(root, 'codex-source');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, AUTH_FILE),
    JSON.stringify({ tokens: { access_token: 'sk-restart-canary' } }),
  );

  taskFile = join(root, 'task.yml');
  await writeFile(
    taskFile,
    [
      'id: add-slugify',
      'prompt: Implement the slugify function in src/slugify.js',
      'implementation_paths:',
      '  - src/slugify.js',
      'verification:',
      '  commands:',
      '    - ["npx", "--no-install", "vitest", "run", "--config", "vitest.config.js"]',
      'timeouts:',
      '  connectivity_smoke_seconds: 20',
      '  agent_seconds: 300',
      '  termination_grace_seconds: 2',
      '',
    ].join('\n'),
  );

  // The production CLI has no stub seam, so the run that gets killed is driven directly.
  runnerScript = join(root, 'runner.mjs');
  await writeFile(
    runnerScript,
    [
      "import { appendFile } from 'node:fs/promises';",
      `import { runTask } from ${JSON.stringify(join(process.cwd(), 'dist/run/orchestrator.js'))};`,
      'await runTask({',
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

async function labelled(kind: 'container' | 'volume' | 'network'): Promise<string[]> {
  const filter = `label=${ATTEMPT_LABEL}`;
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', filter]
      : [kind, 'ls', '-q', '--filter', filter];

  const { stdout } = await execa('docker', args);
  return stdout.split('\n').filter((line) => line !== '');
}

/** Wait until the set of labelled resources stops changing, so stragglers are counted. */
async function settled(): Promise<void> {
  let previous = '';

  for (let poll = 0; poll < 40; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));

    const current = (
      await Promise.all((['container', 'volume', 'network'] as const).map(labelled))
    )
      .flat()
      .sort()
      .join(',');

    if (current !== '' && current === previous) return;
    previous = current;
  }
}

describe('a SIGKILLed run is cleaned up by the next production CLI start', () => {
  it('removes the orphans before the new attempt, without touching the killed run itself', async () => {
    const artifacts = await mkdtemp(join(tmpdir(), 'harness-artifacts-'));
    const phasesFile = join(root, 'phases');
    await writeFile(phasesFile, '');

    const killed = execa('node', [runnerScript], {
      reject: false,
      env: {
        HARNESS_TEST_PHASES: phasesFile,
        HARNESS_TEST_RUN: JSON.stringify({
          taskFile,
          repoPath: repo.dir,
          artifactDir: artifacts,
          sourceCodexHome: join(root, 'codex-source'),
          storeDirectory: join(root, 'store'),
          dependencyCacheDirectory: join(root, 'deps'),
          injection: {
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

      killed.kill('SIGKILL');
      await killed;
      await settled();

      // No teardown ran: --rm does not apply to a running container, and the attempt id that
      // owned these resources died with the process.
      expect(await labelled('container')).not.toEqual([]);
      expect(await labelled('volume')).not.toEqual([]);

      // The real binary. It fails in the export phase — after the startup sweep, before any
      // container — so the check costs no provider tokens.
      const restarted = await execa(
        'node',
        ['dist/cli.js', 'run', taskFile, '--repo', join(root, 'no-such-repo')],
        { reject: false, env: { HARNESS_STATE_DIR: join(root, 'state') } },
      );

      const report = JSON.parse(restarted.stdout) as { status: string; failedPhase?: string };
      expect(report.status).toBe('failed');
      expect(report.failedPhase).toBe('export');

      // The sweep is what removed them: this CLI run never got far enough to create anything.
      expect(await labelled('container')).toEqual([]);
      expect(await labelled('volume')).toEqual([]);
      expect(await labelled('network')).toEqual([]);
    } finally {
      await rm(artifacts, { recursive: true, force: true });

      for (let pass = 0; pass < 10; pass += 1) {
        const survivors = await labelled('container');
        if (survivors.length > 0) {
          await execa('docker', ['rm', '--force', ...survivors], { reject: false });
        }
        for (const kind of ['volume', 'network'] as const) {
          const rest = await labelled(kind);
          if (rest.length > 0) await execa('docker', [kind, 'rm', ...rest], { reject: false });
        }

        const remaining = await Promise.all(
          (['container', 'volume', 'network'] as const).map(labelled),
        );
        if (remaining.every((list) => list.length === 0)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }, 900_000);
});
