import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_HOME_PATH,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  compileCodexPolicy,
  materializeCodexHome,
} from '../../src/adapters/codex/policy.js';

const PROMPT = 'Implement slugify in src/slugify.js';
const WORKDIR = '/workspace';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-codex-home-'));
  dirs.push(dir);
  return dir;
}

const policy = (): ReturnType<typeof compileCodexPolicy> =>
  compileCodexPolicy({ prompt: PROMPT, workdir: WORKDIR });

describe('codex policy', () => {
  it('materializes a CODEX_HOME containing a generated config.toml', async () => {
    const dir = await tempDir();
    await materializeCodexHome(policy(), dir);

    const config = await readFile(join(dir, 'config.toml'), 'utf8');
    expect(config).toContain('model =');
  });

  it('disables web search, MCP, auto-update and telemetry', () => {
    const config = policy().files['config.toml'] ?? '';

    expect(config).toContain('web_search = "disabled"');
    expect(config).toContain('mcp_servers = {}');
    expect(config).toContain('in_app_updates = false');
    expect(config).toContain('[otel]');
    expect(config).toContain('exporter = "none"');
  });

  it('pins model and effort explicitly', () => {
    const config = policy().files['config.toml'] ?? '';

    expect(config).toContain(`model = "${DEFAULT_MODEL}"`);
    expect(config).toContain(`model_reasoning_effort = "${DEFAULT_REASONING_EFFORT}"`);
  });

  it('emits exactly the §27 container contract argv', () => {
    expect(policy().args).toEqual([
      'codex',
      'exec',
      '--strict-config',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      '--ephemeral',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--cd',
      WORKDIR,
      '--model',
      DEFAULT_MODEL,
      PROMPT,
    ]);
  });

  it('cannot be configured to drop the inner-sandbox bypass', () => {
    const hostile = compileCodexPolicy({
      prompt: PROMPT,
      workdir: WORKDIR,
      bypassInnerSandbox: false,
      sandbox: 'read-only',
    } as Parameters<typeof compileCodexPolicy>[0]);

    expect(hostile.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(hostile.args).not.toContain('--sandbox');
  });

  it('places --strict-config on the exec invocation specifically', () => {
    const args = policy().args;

    expect(args[0]).toBe('codex');
    expect(args[1]).toBe('exec');
    expect(args.indexOf('--strict-config')).toBeGreaterThan(args.indexOf('exec'));
    expect(args).not.toContain('features');
  });

  it('passes the prompt as an argument and declares stdin closed', () => {
    const compiled = policy();

    expect(compiled.args.at(-1)).toBe(PROMPT);
    expect(compiled.args).not.toContain('-');
    expect(compiled.stdin).toBe('closed');
  });

  it('never passes --ignore-user-config, which would discard the policy', () => {
    // Mutually exclusive with the generated config.toml: CODEX_HOME is the only channel
    // for policy delivery, and that flag turns it off for everything but auth.
    expect(policy().args).not.toContain('--ignore-user-config');
  });

  it('hashes config content and argv together', () => {
    const base = policy();

    expect(base.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(compileCodexPolicy({ prompt: PROMPT, workdir: WORKDIR }).hash).toBe(base.hash);
    expect(compileCodexPolicy({ prompt: 'different', workdir: WORKDIR }).hash).not.toBe(base.hash);
    expect(
      compileCodexPolicy({ prompt: PROMPT, workdir: WORKDIR, reasoningEffort: 'high' }).hash,
    ).not.toBe(base.hash);
  });

  it('takes nothing from the user real Codex home', async () => {
    const fakeHome = await tempDir();
    await mkdir(join(fakeHome, '.codex'), { recursive: true });
    await writeFile(
      join(fakeHome, '.codex/config.toml'),
      'model = "USER_CANARY_MODEL"\nbogus_user_key = true\n',
    );

    const previous = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const compiled = policy();
      const serialized = JSON.stringify(compiled);

      expect(serialized).not.toContain('USER_CANARY_MODEL');
      expect(serialized).not.toContain('bogus_user_key');
      expect(compiled.env.CODEX_HOME).toBe(CODEX_HOME_PATH);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  });
});
