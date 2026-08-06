import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import type { RuntimeImage } from '../../src/docker/images.js';
import { bundleRootFor, writeBundle } from '../../src/docs/bundle.js';
import { runSinglePlanStep, type RunReport } from '../../src/run/bridge.js';
import {
  createTargetRepo,
  git,
  removePlanBranches,
  removeRepo,
  type TargetRepo,
} from '../helpers/repo.js';
import { planDocument } from '../helpers/plan.js';
import { cannedEvents, stubAgentImage } from '../helpers/stub-agent.js';

const REPORT_PATH = 'src/context-report.txt';
const OPENAPI = '{"openapi":"3.1.0","info":{"title":"Weather"}}';
const SOURCES = [
  { url: 'https://example.com/openapi.json', path: 'example/openapi.json' },
  { url: 'https://example.com/guide.md', path: 'guide.md' },
];

let repo: TargetRepo;
let root: string;
let stub: RuntimeImage;
const dirs: string[] = [];

const STEP = [
  'type: task',
  'complexity: low',
  'risk: standard',
  'id: read-context',
  'observable_behavior: Report what the documentation context contains.',
  'implementation_paths:',
  `  - ${REPORT_PATH}`,
  'verification:',
  '  commands:',
  '    - ["node", "--version"]',
  'timeouts:',
  '  connectivity_smoke_seconds: 20',
  '  agent_seconds: 60',
  '  termination_grace_seconds: 2',
];

beforeAll(async () => {
  stub = await stubAgentImage();
  repo = await createTargetRepo();
  root = await mkdtemp(join(tmpdir(), 'harness-docs-context-'));

  const source = join(root, 'codex-source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, AUTH_FILE), JSON.stringify({ tokens: { access_token: 'stub' } }));
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await removePlanBranches(repo.dir);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-docs-run-'));
  dirs.push(dir);
  return dir;
}

/** A plan file with, or without, a documentation block and the bundle beside it. */
async function planFile(documented: boolean): Promise<string> {
  const dir = await scratch();
  const file = join(dir, 'plan.yml');

  await writeFile(
    file,
    planDocument(STEP, { id: 'context-plan', ...(documented ? { documentation: SOURCES } : {}) }),
  );

  if (documented) {
    await writeBundle(bundleRootFor(file), [
      { ...(SOURCES[0] as (typeof SOURCES)[number]), bytes: Buffer.from(OPENAPI, 'utf8'), fetchedAt: '2026-01-01T00:00:00.000Z' },
      {
        ...(SOURCES[1] as (typeof SOURCES)[number]),
        bytes: Buffer.from('# guide\n', 'utf8'),
        fetchedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  }

  return file;
}

async function run(documented: boolean): Promise<{ report: RunReport; artifacts: string; plan: string }> {
  const artifacts = await scratch();
  const plan = await planFile(documented);

  const report = await runSinglePlanStep({
    planFile: plan,
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
        STUB_CONTEXT_REPORT_PATH: REPORT_PATH,
        STUB_CONTEXT_FILE: 'example/openapi.json',
      },
    },
  });

  return { report, artifacts, plan };
}

async function committedReport(report: RunReport): Promise<string> {
  return git(repo.dir, ['show', `${report.commit ?? ''}:${REPORT_PATH}`]);
}

describe('approved documentation at /context', () => {
  it('is present, readable by the agent, and byte-identical to the bundle', async () => {
    const { report, plan } = await run(true);
    expect(report.status).toBe('succeeded');

    const seen = await committedReport(report);
    const index = await readFile(join(bundleRootFor(plan), 'context', 'index.md'), 'utf8');

    expect(seen).toContain('context: present');
    expect(seen).toContain(index.trim());
    expect(seen).toContain(OPENAPI);
  }, 900_000);

  it('is read-only: the agent cannot write into it and the host bundle is unchanged', async () => {
    const { report, plan } = await run(true);

    expect(await committedReport(report)).toContain('write: refused');
    await expect(
      readFile(join(bundleRootFor(plan), 'context', 'tampered.md')),
    ).rejects.toThrow();
  }, 900_000);

  it('is recorded in the run manifest as hash, source count and total bytes', async () => {
    const { artifacts } = await run(true);

    const manifest = JSON.parse(
      await readFile(join(artifacts, 'run-manifest.json'), 'utf8'),
    ) as { inputs: { documentation?: { hash: string; sources: number; bytes: number } } };

    expect(manifest.inputs.documentation).toEqual({
      hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      sources: 2,
      bytes: OPENAPI.length + '# guide\n'.length,
    });
  }, 900_000);

  it('is absent entirely for a plan that declares no documentation', async () => {
    const { report, artifacts } = await run(false);
    expect(report.status).toBe('succeeded');

    expect(await committedReport(report)).toContain('context: absent');

    const manifest = JSON.parse(
      await readFile(join(artifacts, 'run-manifest.json'), 'utf8'),
    ) as { inputs: Record<string, unknown> };
    expect(manifest.inputs).not.toHaveProperty('documentation');

    const prompt = await readFile(join(artifacts, 'prompt.txt'), 'utf8');
    expect(prompt).not.toContain('/context');
  }, 900_000);
});
