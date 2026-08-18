import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { EventParseError } from '../../src/adapters/codex/events.js';
import { buildAgentSpec, runCodexAgent, type AgentRunResult } from '../../src/adapters/codex/run.js';
import { AUTH_FILE, readAuthStore, seedAuthStore } from '../../src/auth/store.js';
import { authMount, createAuthVolume } from '../../src/auth/volume.js';
import { compileCodexPolicy } from '../../src/adapters/codex/policy.js';
import { DependencyCache, ensureDependencySnapshot } from '../../src/deps/setup.js';
import { createDependencyVolume, dependencyMount } from '../../src/deps/volume.js';
import { exportCommit } from '../../src/git/export.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { runContainer } from '../../src/docker/run.js';
import { usageSection } from '../../src/run/manifest.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { createWorkspaceVolume, removeVolume, workspaceMount } from '../../src/volume/workspace.js';
import { DEPENDENCY_CACHE } from '../helpers/deps.js';
import { createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';
import { runtimeImages } from '../helpers/images.js';
import {
  STUB_AGENT_IMAGE,
  cannedEvents,
  stubAgentImage,
} from '../helpers/stub-agent.js';

const PROMPT = 'Implement the slugify function in src/slugify.js';
const CANARY = 'sk-live-canary-4b81f0c2d7e6a9';

let repo: TargetRepo;
let tar: Buffer;
let deps: Buffer;
let authVolume: string;
let root: string;
let images: RuntimeImages;
let stubImages: RuntimeImages;
const volumes: string[] = [];
const artifactDirs: string[] = [];

beforeAll(async () => {
  images = await runtimeImages();
  stubImages = { ...images, codex: await stubAgentImage() };

  repo = await createTargetRepo();
  ({ tar } = await exportCommit(repo.dir, repo.commit));

  root = await mkdtemp(join(tmpdir(), 'enactment-agent-'));

  const cache = new DependencyCache(DEPENDENCY_CACHE);
  await ensureDependencySnapshot({
    cache,
    key: 'sha256:agent-run-tests',
    attempt: newAttemptId(),
    workspaceTar: tar,
    installCommand: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    network: 'bridge',
    images,
  });
  deps = await cache.read('sha256:agent-run-tests');

  const source = join(root, 'codex-source');
  await prepareSource(source);
  const store = await seedAuthStore(join(root, 'store'), source);

  authVolume = await createAuthVolume(
    newAttemptId(),
    {
      provider: 'codex',
      auth: await readAuthStore(store),
      policy: compileCodexPolicy({ prompt: PROMPT, workdir: '/workspace' }).files,
    },
    images,
  );
}, 600_000);

async function prepareSource(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, AUTH_FILE),
    JSON.stringify({ tokens: { access_token: CANARY, refresh_token: `refresh-${CANARY}` } }),
  );
}

afterAll(async () => {
  await removeVolume(authVolume);
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(volumes.splice(0).map((name) => removeVolume(name)));
  await Promise.all(
    artifactDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function attemptResources(): Promise<{ workspace: string; depsVolume: string; artifacts: string }> {
  const attempt = newAttemptId();
  const workspace = await createWorkspaceVolume(attempt, tar, images);
  const depsVolume = await createDependencyVolume(attempt, 'agent', deps, images);
  const artifacts = await mkdtemp(join(tmpdir(), 'enactment-artifacts-'));

  volumes.push(workspace, depsVolume);
  artifactDirs.push(artifacts);

  return { workspace, depsVolume, artifacts };
}

async function runStub(
  mode: string,
  events: string,
  overrides: Partial<Parameters<typeof runCodexAgent>[0]> = {},
): Promise<AgentRunResult & { artifacts: string }> {
  const { workspace, depsVolume, artifacts } = await attemptResources();

  const result = await runCodexAgent({
    images: stubImages,
    prompt: PROMPT,
    network: 'none',
    env: { STUB_MODE: mode, STUB_EVENTS: events },
    mounts: [workspaceMount(workspace), dependencyMount(depsVolume), authMount('codex', authVolume)],
    timeoutSeconds: 60,
    graceSeconds: 2,
    artifactDir: artifacts,
    secrets: [CANARY],
    ...overrides,
  });

  return { ...result, artifacts };
}

describe('agent invocation', () => {
  it('parses canned events in order', async () => {
    const result = await runStub('events', cannedEvents());

    expect(result.status).toBe('completed');
    expect(result.events.map((event) => event.type)).toEqual([
      'thread.started',
      'turn.started',
      'item.completed',
      'turn.completed',
    ]);
  }, 120_000);

  it('extracts token usage and model metadata for the run manifest', async () => {
    const result = await runStub('events', cannedEvents());

    expect(usageSection(result.usage)).toEqual({
      model: 'gpt-5.6-luna',
      input_tokens: 1234,
      output_tokens: 567,
      cached_input_tokens: 89,
    });
  }, 120_000);

  it('mounts the workspace, the dependency volume and the auth directory, and nothing else', async () => {
    const { workspace, depsVolume, artifacts } = await attemptResources();

    // The real spec the adapter would run, with only the command swapped for a probe:
    // a mount added anywhere in buildAgentSpec fails this test.
    const spec = buildAgentSpec({
      prompt: PROMPT,
      network: 'none',
      env: { STUB_MODE: 'mounts', STUB_EVENTS: '' },
      mounts: [workspaceMount(workspace), dependencyMount(depsVolume), authMount('codex', authVolume)],
      timeoutSeconds: 60,
      graceSeconds: 2,
      artifactDir: artifacts,
      images: stubImages,
    });

    const result = await runContainer({
      ...spec,
      argv: ['sh', '-c', 'awk "{ print \\$5 }" /proc/self/mountinfo | sort -u'],
    });

    const targets = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\/(workspace|run|home|srv|opt|mnt|data|var)/.test(line))
      .sort();

    expect(targets).toEqual([
      '/home/agent',
      '/run/agent-auth',
      '/workspace',
      '/workspace/node_modules',
    ]);
  }, 120_000);

  it('redacts secrets from the stored event log', async () => {
    const leak = { type: 'item.completed', item: { type: 'reasoning', text: `token ${CANARY}` } };
    const result = await runStub('events', cannedEvents([leak]));

    const stored = await readFile(join(result.artifacts, 'agent-events.jsonl'), 'utf8');
    expect(stored).not.toContain(CANARY);
    expect(stored).toContain('[redacted]');
  }, 120_000);

  it('reports a non-zero exit as an agent failure with stderr', async () => {
    const result = await runStub('fail', '');

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain('stub agent failed');
  }, 120_000);

  it('terminates a hanging agent at its budget and removes the container', async () => {
    const started = Date.now();
    const result = await runStub('hang', '', { timeoutSeconds: 3, graceSeconds: 2 });

    expect(result.status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(60_000);

    const survivors = await runContainer({
      image: STUB_AGENT_IMAGE,
      argv: ['true'],
      network: 'none',
    });
    expect(survivors.exitCode).toBe(0);
  }, 120_000);

  it('reports malformed JSONL as a parse error rather than truncating', async () => {
    let failure: unknown;
    try {
      await runStub('malformed', 'this is not json\n{"type":"turn.started"}');
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(EventParseError);
    expect((failure as Error).message).toMatch(/line 1/);
  }, 120_000);

  it('stores the prompt as an artifact', async () => {
    const result = await runStub('events', cannedEvents());

    expect(await readFile(join(result.artifacts, 'prompt.txt'), 'utf8')).toBe(PROMPT);
  }, 120_000);

});
