import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { resolveRuntimeImages } from '../../src/docker/images.js';
import { parseCommand } from '../../src/run/options.js';
import { execute } from '../../src/run/production.js';
import { createM2Repo, removeRepo, type TargetRepo } from '../helpers/repo.js';

/**
 * Image IDs are the only manifest field that comes from Docker. Every hermetic test proves the
 * approval contract against injected values, so this is the one check that it holds against the
 * real daemon — and across processes, since a manifest written by one run has to be accepted by
 * the next. No agent runs: prepare, then validate.
 */

let repo: TargetRepo;
const dirs: string[] = [];

beforeAll(async () => {
  repo = await createM2Repo();
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('prepare against the real daemon', () => {
  it('records image IDs a later validation accepts unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-prepare-'));
    dirs.push(dir);

    const planFile = join(dir, 'plan.yml');
    await writeFile(
      planFile,
      [
        'version: 1',
        'id: prepare-plan',
        'steps:',
        '  - type: task',
        '    complexity: low',
        '    id: only-step',
        '    observable_behavior: Do the thing.',
        '    implementation_paths:',
        '      - only-step.txt',
        '    verification:',
        '      commands:',
        '        - ["node", "--version"]',
        'final_verification:',
        '  commands:',
        '    - ["node", "--version"]',
        '',
      ].join('\n'),
    );

    const manifestPath = join(dir, 'execution-manifest.yml');
    const prepared = await execute(
      parseCommand(['prepare', planFile, '--repo', repo.dir, '--output', manifestPath], {}),
    );

    expect(prepared.exitCode).toBe(0);

    const images = await resolveRuntimeImages();
    expect(prepared.report).toMatchObject({
      runtime: {
        codex_image_id: images.codex.id,
        claude_image_id: images.claude.id,
        verifier_image_id: images.verifier.id,
        setup_image_id: images.setup.id,
        proxy_image_id: images.proxy.id,
      },
    });

    // A separate process, resolving the images itself: what prepare recorded is what a later
    // validation accepts. It stops at the coordinator, so nothing is executed.
    const validated = await execa(
      'node',
      [
        '--input-type=module',
        '-e',
        [
          `import { loadManifest, validateManifest } from ${JSON.stringify(join(process.cwd(), 'dist/plan/execution-manifest.js'))};`,
          `const approved = await validateManifest(await loadManifest(${JSON.stringify(manifestPath)}), {`,
          `  repoPath: ${JSON.stringify(repo.dir)},`,
          '});',
          'process.stdout.write(JSON.stringify({ plan: approved.plan.id, images: approved.images }));',
        ].join('\n'),
      ],
      { reject: false },
    );

    expect(validated.exitCode, validated.stderr).toBe(0);
    expect(JSON.parse(validated.stdout)).toEqual({ plan: 'prepare-plan', images });
  }, 300_000);
});
