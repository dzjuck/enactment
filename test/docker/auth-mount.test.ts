import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_FILE, authEnv, readAuthStore, seedAuthStore } from '../../src/auth/store.js';
import { authMount, createAuthVolume } from '../../src/auth/volume.js';
import { CODEX_HOME_PATH, compileCodexPolicy } from '../../src/adapters/codex/policy.js';
import { type ImageRole } from '../../src/config/pins.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import { runContainer, type RunResult } from '../../src/docker/run.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { removeVolume } from '../../src/volume/workspace.js';
import { runtimeImages } from '../helpers/images.js';

let images: RuntimeImages;
let source: string;
let authVolume: string;

beforeAll(async () => {
  images = await runtimeImages();
  source = await mkdtemp(join(tmpdir(), 'harness-codex-source-'));
  await writeFile(
    join(source, AUTH_FILE),
    JSON.stringify({ tokens: { access_token: 'access-canary' } }),
  );

  const store = await seedAuthStore(await mkdtemp(join(tmpdir(), 'harness-store-')), source);
  const policy = compileCodexPolicy({ prompt: 'noop', workdir: '/workspace' });

  authVolume = await createAuthVolume(
    newAttemptId(),
    { auth: await readAuthStore(store), policy: policy.files },
    images,
  );
});

afterAll(async () => {
  await removeVolume(authVolume);
  await rm(source, { recursive: true, force: true });
});

const probe = ['sh', '-c', `cat ${CODEX_HOME_PATH}/${AUTH_FILE} 2>&1; env | grep -c CODEX_HOME`];

function run(role: ImageRole, withAuth: boolean): Promise<RunResult> {
  return runContainer({
    image: images[role].id,
    argv: probe,
    network: 'none',
    ...(withAuth ? { env: authEnv(), mounts: [authMount(authVolume)] } : {}),
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
      image: images.agent.id,
      argv: ['sh', '-c', `touch ${CODEX_HOME_PATH}/rotation-probe`],
      network: 'none',
      env: authEnv(),
      mounts: [authMount(authVolume)],
    });

    expect(result.exitCode).toBe(0);
  });

  it('gives the setup and verifier images no auth volume mount at all', () => {
    // The mount is a volume, never a bind of the host store: no host ownership is involved,
    // so the same contract holds on OrbStack, Docker Desktop and native Linux.
    expect(authMount(authVolume).type).toBe('volume');
  });
});
