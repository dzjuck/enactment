import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE, authEnv, authMount, prepareRunAuth, seedAuthStore } from '../../src/auth/store.js';
import { CODEX_HOME_PATH } from '../../src/adapters/codex/policy.js';
import { IMAGE_PINS, type ImageRole } from '../../src/config/pins.js';
import { runContainer, type RunResult } from '../../src/docker/run.js';

let source: string;
let runHome: string;

beforeAll(async () => {
  source = await mkdtemp(join(tmpdir(), 'harness-codex-source-'));
  await writeFile(
    join(source, AUTH_FILE),
    JSON.stringify({ tokens: { access_token: 'access-canary' } }),
  );

  const store = await seedAuthStore(await mkdtemp(join(tmpdir(), 'harness-store-')), source);
  runHome = await mkdtemp(join(tmpdir(), 'harness-run-home-'));
  await prepareRunAuth(store, runHome);
});

afterAll(async () => {
  await rm(source, { recursive: true, force: true });
  await rm(runHome, { recursive: true, force: true });
});

const probe = ['sh', '-c', `cat ${CODEX_HOME_PATH}/${AUTH_FILE} 2>&1; env | grep -c CODEX_HOME`];

function run(role: ImageRole, withAuth: boolean): Promise<RunResult> {
  return runContainer({
    image: IMAGE_PINS[role].tag,
    argv: probe,
    network: 'none',
    ...(withAuth ? { env: authEnv(), mounts: [authMount(runHome)] } : {}),
  });
}

describe('provider auth mount', () => {
  it('control: the agent container receives the credentials', async () => {
    const result = await run('agent', true);

    expect(result.stdout).toContain('access-canary');
    expect(result.stdout.trim().endsWith('1')).toBe(true);
  });

  it.each<ImageRole>(['verifier', 'setup'])(
    'gives the %s container no auth mount and no auth variable',
    async (role) => {
      const result = await run(role, false);

      expect(result.stdout).not.toContain('access-canary');
      expect(result.stdout.trim().endsWith('0')).toBe(true);
    },
  );

  it('mounts the credentials read-write, as rotation requires', async () => {
    const result = await runContainer({
      image: IMAGE_PINS.agent.tag,
      argv: ['sh', '-c', `touch ${CODEX_HOME_PATH}/rotation-probe`],
      network: 'none',
      env: authEnv(),
      mounts: [authMount(runHome)],
    });

    expect(result.exitCode).toBe(0);
  });
});
