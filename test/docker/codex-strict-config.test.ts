import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CODEX_HOME_PATH,
  compileCodexPolicy,
  materializeCodexHome,
} from '../../src/adapters/codex/policy.js';
import { IMAGE_PINS } from '../../src/config/pins.js';
import { runContainer, type RunResult } from '../../src/docker/run.js';

const BOGUS_KEY = 'bogus_probe_key';

/**
 * Codex never exits on its own when it cannot reach the provider — it retries and reconnects —
 * so both controls run until this budget expires. It only has to be long enough for the
 * connection failure to reach the log, which measurement puts under three seconds.
 */
const CONNECT_FAILURE_SECONDS = 6;

let validHome: string;
let invalidHome: string;

const policy = compileCodexPolicy({ prompt: 'noop', workdir: '/tmp' });

/**
 * Offline and unauthenticated on purpose: configuration validation must happen before any
 * model call, so a config verdict here cannot have come from the provider.
 */
function runCodex(home: string, args: string[], timeoutSeconds = 30): Promise<RunResult> {
  return runContainer(
    {
      image: IMAGE_PINS.codex.tag,
      argv: args,
      network: 'none',
      env: { CODEX_HOME: CODEX_HOME_PATH },
      mounts: [{ type: 'bind', source: home, target: CODEX_HOME_PATH }],
    },
    { timeoutSeconds, graceSeconds: 2 },
  );
}

beforeAll(async () => {
  validHome = await mkdtemp(join(tmpdir(), 'enactment-codex-valid-'));
  invalidHome = await mkdtemp(join(tmpdir(), 'enactment-codex-invalid-'));

  await materializeCodexHome(policy, validHome);
  await materializeCodexHome(policy, invalidHome);
  await appendFile(join(invalidHome, 'config.toml'), `\n${BOGUS_KEY} = true\n`);
});

afterAll(async () => {
  await rm(validHome, { recursive: true, force: true });
  await rm(invalidHome, { recursive: true, force: true });
});

describe('--strict-config', () => {
  it('rejects an unrecognized configuration key, naming it', async () => {
    const result = await runCodex(invalidHome, policy.args);
    const output = result.stdout + result.stderr;

    expect(result.exitCode).not.toBe(0);
    expect(output).toContain('unknown configuration field');
    expect(output).toContain(BOGUS_KEY);
  }, 120_000);

  it('positive control: the same invocation accepts a valid configuration', async () => {
    const result = await runCodex(validHome, policy.args, CONNECT_FAILURE_SECONDS);
    const output = result.stdout + result.stderr;

    // It cannot succeed offline, but it must get past config validation to fail on the
    // network. Without this half, a rejected flag would look like a working strict mode.
    expect(output).not.toContain('unknown configuration field');
    expect(output).not.toContain('Error loading config.toml');
    expect(output).not.toContain('unexpected argument');
    expect(output).toMatch(/websocket|connect|stream disconnected|thread\.started/i);
  }, 120_000);

  it('control: without --strict-config the same key is silently tolerated', async () => {
    const loose = policy.args.filter((arg) => arg !== '--strict-config');

    const result = await runCodex(invalidHome, loose, CONNECT_FAILURE_SECONDS);
    const output = result.stdout + result.stderr;

    expect(output).not.toContain('unknown configuration field');
    expect(output).toMatch(/websocket|connect|stream disconnected|thread\.started/i);
  }, 120_000);
});
