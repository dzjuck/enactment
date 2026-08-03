import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildAgentSpec } from '../../src/adapters/codex/run.js';
import { AGENT_HOME, buildRunArgs } from '../../src/docker/args.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { CliUsageError, parseRunOptions } from '../../src/run/options.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const digits = (value: number): string => `sha256:${String(value).repeat(64)}`;

const IMAGES: RuntimeImages = {
  agent: { role: 'agent', id: digits(1) },
  verifier: { role: 'verifier', id: digits(2) },
  setup: { role: 'setup', id: digits(3) },
  proxy: { role: 'proxy', id: digits(4) },
};

const BASE = ['run', 'plan.yml', '--repo', '/repo'];

describe('CLI option parsing', () => {
  it('accepts the supported production options', () => {
    const options = parseRunOptions([...BASE, '--artifacts', '/out'], {});

    expect(options.planFile).toBe('plan.yml');
    expect(options.repoPath).toBe('/repo');
    expect(options.artifactDir).toBe('/out');
  });

  it('rejects --agent-image, naming it', () => {
    const error = (() => {
      try {
        parseRunOptions([...BASE, '--agent-image', 'ai-harness/stub-agent:test'], {});
        return undefined;
      } catch (cause: unknown) {
        return cause;
      }
    })();

    expect(error).toBeInstanceOf(CliUsageError);
    expect((error as Error).message).toContain('--agent-image');
  });

  it('rejects any other unknown option instead of silently dropping it', () => {
    expect(() => parseRunOptions([...BASE, '--network', 'host'], {})).toThrow(CliUsageError);
    expect(() => parseRunOptions([...BASE, '--policy', 'off'], {})).toThrow(CliUsageError);
  });

  it('requires the run command, a plan file and a repository', () => {
    expect(() => parseRunOptions(['plan.yml', '--repo', '/repo'], {})).toThrow(CliUsageError);
    expect(() => parseRunOptions(['run', '--repo', '/repo'], {})).toThrow(CliUsageError);
    expect(() => parseRunOptions(['run', 'plan.yml'], {})).toThrow(CliUsageError);
  });

  it('reads only the harness state environment variables', () => {
    const options = parseRunOptions(BASE, {
      HARNESS_SOURCE_CODEX_HOME: '/codex',
      HARNESS_STORE_DIR: '/store',
      HARNESS_DEPS_DIR: '/deps',
    });

    expect(options.sourceCodexHome).toBe('/codex');
    expect(options.storeDirectory).toBe('/store');
    expect(options.dependencyCacheDirectory).toBe('/deps');
  });
});

describe('HARNESS_AGENT_ENV has no production effect', () => {
  it('contributes nothing to the parsed run options', () => {
    const options = parseRunOptions(BASE, {
      HARNESS_AGENT_ENV: JSON.stringify({
        CODEX_HOME: '/evil',
        HOME: '/evil',
        HTTPS_PROXY: 'http://evil:3128',
      }),
    });

    expect(JSON.stringify(options)).not.toContain('evil');
    expect(Object.keys(options)).not.toContain('agentEnv');
    expect(Object.keys(options)).not.toContain('agentImage');
  });

  it('is named nowhere in the production source tree, and neither is --agent-image', async () => {
    const files = (await readdir(SRC, { withFileTypes: true, recursive: true })).filter((entry) =>
      entry.isFile(),
    );
    expect(files.length).toBeGreaterThan(0);

    for (const entry of files) {
      const source = await readFile(join(entry.parentPath, entry.name), 'utf8');
      expect(source, entry.name).not.toContain('HARNESS_AGENT_ENV');
      expect(source, entry.name).not.toContain('agent-image');
    }
  });

  it('cannot displace the compiled policy, CODEX_HOME or HOME in the agent container', () => {
    const spec = buildAgentSpec({
      prompt: 'implement it',
      network: 'egress',
      env: { CODEX_HOME: '/evil', HOME: '/evil', HTTPS_PROXY: 'http://proxy:8080' },
      mounts: [],
      timeoutSeconds: 5,
      graceSeconds: 1,
      artifactDir: '/tmp/artifacts',
      images: IMAGES,
    });
    const argv = buildRunArgs(spec);

    expect(spec.image).toBe(IMAGES.agent.id);
    expect(argv).toContain('CODEX_HOME=/run/agent-auth');
    expect(argv).toContain(`HOME=${AGENT_HOME}`);
    expect(argv).not.toContain('CODEX_HOME=/evil');
    expect(argv).not.toContain('HOME=/evil');
    // What the harness itself supplies still reaches the container.
    expect(argv).toContain('HTTPS_PROXY=http://proxy:8080');
  });
});
