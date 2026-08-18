import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE } from '../../src/auth/store.js';
import type { RuntimeImage } from '../../src/docker/images.js';
import type { RunInjection } from '../../src/run/inject.js';
import { runSinglePlanStep } from '../../src/run/bridge.js';
import { authVolumeName } from '../../src/volume/naming.js';
import { DEPENDENCY_CACHE } from '../helpers/deps.js';
import { planDocument } from '../helpers/plan.js';
import { createTargetRepo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';
import {
  cannedClaudeEvents,
  cannedEvents,
  stubAgentImage,
  stubClaudeImage,
} from '../helpers/stub-agent.js';

const IMPLEMENTATION = 'export const routed = true;\n';
const dirs: string[] = [];
const repos: TargetRepo[] = [];
let codexStub: RuntimeImage;
let claudeStub: RuntimeImage;

beforeAll(async () => {
  codexStub = await stubAgentImage();
  claudeStub = await stubClaudeImage();
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(repos.splice(0).map((repo) => removeRepo(repo.dir)));
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function authFiles(root: string): Promise<{ sourceCodexHome: string; claudeTokenFile: string }> {
  const sourceCodexHome = join(root, 'codex-source');
  await mkdir(sourceCodexHome, { recursive: true });
  await writeFile(
    join(sourceCodexHome, AUTH_FILE),
    JSON.stringify({ tokens: { access_token: 'codex-access', refresh_token: 'codex-refresh' } }),
  );

  const claudeDir = join(root, 'auth', 'claude');
  const claudeTokenFile = join(claudeDir, 'token');
  await mkdir(claudeDir, { recursive: true, mode: 0o700 });
  await chmod(claudeDir, 0o700);
  await writeFile(claudeTokenFile, 'claude-token', { mode: 0o600 });
  await chmod(claudeTokenFile, 0o600);

  return { sourceCodexHome, claudeTokenFile };
}

async function authVolumes(attempt: string): Promise<string[]> {
  const { stdout } = await execa('docker', [
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=enactment.attempt=${attempt}`,
  ]);
  return stdout.split('\n').filter((name) => name.includes('-auth-'));
}

async function run(
  complexity: 'low' | 'medium' | 'high',
  options: { reportedModel?: string } = {},
) {
  const repo = await createTargetRepo();
  repos.push(repo);
  const root = await scratch('enactment-provider-routing-');
  const planFile = join(root, 'plan.yml');
  const artifactDir = join(root, 'artifacts');
  const attempt = `route-${complexity}-${Date.now().toString(36)}`;
  const auth = await authFiles(root);
  const isClaude = complexity === 'medium';
  const requestedModel = isClaude ? 'claude-sonnet-5' : 'gpt-5.6-luna';
  const reportedModel = options.reportedModel ?? requestedModel;

  await writeFile(
    planFile,
    planDocument([
      'type: task',
      `complexity: ${complexity}`,
      'risk: standard',
      `id: route-${complexity}`,
      'observable_behavior: Write src/routed.js',
      'implementation_paths:',
      '  - src/routed.js',
      'verification:',
      '  commands:',
      '    - ["node", "--version"]',
      'timeouts:',
      '  connectivity_smoke_seconds: 20',
      '  agent_seconds: 15',
      '  termination_grace_seconds: 2',
    ]),
  );

  const injection: RunInjection = isClaude
    ? {
        claude: claudeStub,
        attempt,
        agentEnv: {
          STUB_CLAUDE_MODE: 'events',
          STUB_CLAUDE_EVENTS: cannedClaudeEvents().replace(
            'claude-sonnet-5',
            reportedModel,
          ),
          STUB_WRITE_PATH: 'src/routed.js',
          STUB_WRITE_CONTENT: IMPLEMENTATION,
        },
      }
    : {
        codex: codexStub,
        attempt,
        agentEnv: {
          STUB_MODE: 'write',
          STUB_EVENTS: cannedEvents().replace('gpt-5.6-luna', reportedModel),
          STUB_WRITE_PATH: 'src/routed.js',
          STUB_WRITE_CONTENT: IMPLEMENTATION,
        },
      };

  let mountedAuth: string[] = [];
  const report = await runSinglePlanStep({
    planFile,
    repoPath: repo.dir,
    artifactDir,
    sourceCodexHome: auth.sourceCodexHome,
    claudeTokenFile: auth.claudeTokenFile,
    storeDirectory: join(root, 'store'),
    dependencyCacheDirectory: DEPENDENCY_CACHE,
    injection,
    onPhase: async (phase) => {
      if (phase === 'agent') mountedAuth = await authVolumes(attempt);
    },
  });

  const manifest = JSON.parse(await readFile(join(artifactDir, 'run-manifest.json'), 'utf8')) as {
    agent_runs: Record<
      string,
      {
        profile: string;
        provider: string;
        cli_version: string;
        requested_model: string;
        reported_model: string | null;
        effort: string;
      }
    >;
  };
  return { repo, report, manifest, attempt, mountedAuth };
}

describe('whole-step provider routing', () => {
  it.each([
    ['low', 'codex-fast', 'codex', 'medium'],
    ['medium', 'claude-balanced', 'claude', 'medium'],
    ['high', 'codex-deep', 'codex', 'high'],
  ] as const)('runs a %s step through %s', async (complexity, profile, provider, effort) => {
    const result = await run(complexity);

    expect(result.report.status).toBe('succeeded');
    expect(result.report.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(result.repo.dir, ['show', `${result.report.commit ?? ''}:src/routed.js`])).toBe(
      IMPLEMENTATION.trim(),
    );
    expect(result.mountedAuth).toEqual([authVolumeName(provider, result.attempt)]);
    expect(await authVolumes(result.attempt)).toEqual([]);
    expect(result.manifest.agent_runs.agent!).toMatchObject({
      profile,
      provider,
      requested_model: provider === 'claude' ? 'claude-sonnet-5' : 'gpt-5.6-luna',
      reported_model: provider === 'claude' ? 'claude-sonnet-5' : 'gpt-5.6-luna',
      effort,
    });
    expect(result.manifest.agent_runs.agent!.cli_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // Codex only: DESIGN §35 measured Codex silently falling back to another model, and this is
  // the gate that catches it.
  it('fails a reported Codex model mismatch before verification and commit', async () => {
    const result = await run('low', { reportedModel: 'unexpected-model' });

    expect(result.report.status).toBe('failed');
    expect(result.report.failedPhase).toBe('agent');
    expect(result.report.commit).toBeUndefined();
    expect(result.report.message).toMatch(/model/i);
    expect(await git(result.repo.dir, ['for-each-ref', 'refs/heads/enactment/'])).toBe('');
  });

  // Claude has no such fallback — a wrong model is a terminal provider error, not a quiet
  // substitution — so a differing reported name is recorded as evidence and commits normally.
  it('records a differing reported Claude model and still commits', async () => {
    const result = await run('medium', { reportedModel: 'claude-sonnet-5-20260514' });

    expect(result.report.status).toBe('succeeded');
    expect(result.report.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.manifest.agent_runs.agent!).toMatchObject({
      requested_model: 'claude-sonnet-5',
      reported_model: 'claude-sonnet-5-20260514',
    });
  });
});
