import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadClaudeToken } from '../../src/auth/claude-token.js';
import { readAuthStore, seedAuthStore, type AuthStore } from '../../src/auth/store.js';
import type { PlanReport } from '../../src/run/coordinator.js';
import { parseCommand } from '../../src/run/options.js';
import { execute } from '../../src/run/production.js';
import { runtimeImages } from '../helpers/images.js';
import { createM2Repo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';

let repo: TargetRepo;
let root: string;
let stateRoot: string;
let planFile: string;
let manifestPath: string;
let artifacts: string;
let token: string;
let codexStore: AuthStore;
let codexAuth: string;
let claudeTokenFile: string;

beforeAll(async () => {
  token = await loadClaudeToken();
  repo = await createM2Repo();
  root = await mkdtemp(join(tmpdir(), 'harness-live-claude-'));
  stateRoot = join(root, 'state');
  artifacts = join(root, 'artifacts');
  planFile = join(root, 'plan.yml');
  manifestPath = join(root, 'execution-manifest.yml');
  codexStore = await seedAuthStore(join(stateRoot, 'auth'));
  codexAuth = await readAuthStore(codexStore);

  await writeFile(
    planFile,
    [
      'version: 1',
      'id: live-claude',
      'steps:',
      '  - type: task',
      '    complexity: medium',
      '    risk: standard',
      '    id: write-claude-note',
      '    observable_behavior: |',
      '      Create claude-live.txt containing exactly: claude live ok',
      '    implementation_paths:',
      '      - claude-live.txt',
      '    verification:',
      '      commands:',
      '        - ["node", "-e", "if (require(\'node:fs\').readFileSync(\'claude-live.txt\', \'utf8\').trim() !== \'claude live ok\') process.exit(1)"]',
      'final_verification:',
      '  commands:',
      '    - ["node", "-e", "if (require(\'node:fs\').readFileSync(\'claude-live.txt\', \'utf8\').trim() !== \'claude live ok\') process.exit(1)"]',
      '',
    ].join('\n'),
  );

  const tokenDirectory = join(stateRoot, 'auth', 'claude');
  await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
  await chmod(tokenDirectory, 0o700);
  claudeTokenFile = join(tokenDirectory, 'token');
  await writeFile(claudeTokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(claudeTokenFile, 0o600);
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

async function artifactText(rootPath: string): Promise<string> {
  const entries = await readdir(rootPath, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  return (
    await Promise.all(files.map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')))
  ).join('\n');
}

describe('real Claude task run', () => {
  it('routes medium complexity through claude-balanced and is a completed-plan no-op on rerun', async () => {
    const images = await runtimeImages();
    const previousStateRoot = process.env.HARNESS_STATE_DIR;
    process.env.HARNESS_STATE_DIR = stateRoot;

    try {
      const prepared = await execute(
        parseCommand(['prepare', planFile, '--repo', repo.dir, '--output', manifestPath]),
      );
      expect(prepared.exitCode).toBe(0);

      const first = await execute(
        parseCommand(['run', manifestPath, '--repo', repo.dir, '--artifacts', artifacts]),
      );
      const report = first.report as PlanReport;
      expect(first.exitCode).toBe(0);
      expect(report.state).toBe('completed');
      expect(report.finalVerification?.status).toBe('pass');
      expect(report.steps[0]?.attempts).toMatchObject([
        { kind: 'normal', profile: 'claude-balanced', state: 'completed' },
      ]);

      const attempt = report.steps[0]?.attempts[0];
      const runRoot = join(
        artifacts,
        'live-claude',
        'steps',
        'write-claude-note',
        attempt?.id ?? '',
        'run-1',
      );
      const manifest = JSON.parse(
        await readFile(join(runRoot, 'run-manifest.json'), 'utf8'),
      ) as {
        runtime: Record<string, string>;
        agent_runs: {
          agent: {
            profile: string;
            provider: string;
            requested_model: string;
            reported_model: string;
          };
        };
        usage: { output_tokens: number };
      };
      expect(manifest.runtime.claude_image_id).toBe(images.claude.id);
      expect(manifest.agent_runs.agent).toMatchObject({
        profile: 'claude-balanced',
        provider: 'claude',
        requested_model: 'claude-sonnet-5',
        reported_model: 'claude-sonnet-5',
      });
      expect(manifest.usage.output_tokens).toBeGreaterThan(0);
      expect(await artifactText(join(artifacts, 'live-claude'))).not.toContain(token);

      const reportsBefore = await readdir(join(artifacts, 'live-claude', 'reports'));
      const commitsBefore = await git(repo.dir, ['rev-list', '--count', 'ai-harness/live-claude']);
      const second = await execute(
        parseCommand(['run', manifestPath, '--repo', repo.dir, '--artifacts', artifacts]),
      );
      expect(second).toEqual(first);
      expect(await readdir(join(artifacts, 'live-claude', 'reports'))).toEqual(reportsBefore);
      expect(await git(repo.dir, ['rev-list', '--count', 'ai-harness/live-claude'])).toBe(
        commitsBefore,
      );

      await writeFile(claudeTokenFile, `${token}\n`, { mode: 0o600 });
      await chmod(claudeTokenFile, 0o600);
      expect(await readAuthStore(codexStore)).toBe(codexAuth);
    } finally {
      if (previousStateRoot === undefined) delete process.env.HARNESS_STATE_DIR;
      else process.env.HARNESS_STATE_DIR = previousStateRoot;
    }
  }, 1_800_000);
});
