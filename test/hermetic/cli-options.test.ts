import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildAgentSpec } from '../../src/adapters/codex/run.js';
import { AGENT_HOME, buildRunArgs } from '../../src/docker/args.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { parseCommand } from '../../src/run/options.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const digits = (value: number): string => `sha256:${String(value).repeat(64)}`;

const IMAGES: RuntimeImages = {
  codex: { role: 'codex', id: digits(1) },
  claude: { role: 'claude', id: digits(5) },
  verifier: { role: 'verifier', id: digits(2) },
  setup: { role: 'setup', id: digits(3) },
  reviewer: { role: 'reviewer', id: digits(5) },
  proxy: { role: 'proxy', id: digits(4) },
};

const BASE = ['run', 'execution-manifest.yml', '--repo', '/repo'];

describe('HARNESS_AGENT_ENV has no production effect', () => {
  it('contributes nothing to the parsed command', () => {
    const options = parseCommand(BASE, {
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

    expect(spec.image).toBe(IMAGES.codex.id);
    expect(argv).toContain('CODEX_HOME=/run/agent-auth');
    expect(argv).toContain(`HOME=${AGENT_HOME}`);
    expect(argv).not.toContain('CODEX_HOME=/evil');
    expect(argv).not.toContain('HOME=/evil');
    // What the harness itself supplies still reaches the container.
    expect(argv).toContain('HTTPS_PROXY=http://proxy:8080');
  });
});
