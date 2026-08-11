import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { pack } from 'tar-stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { RuntimeImages } from '../../src/docker/images.js';
import type { RuntimeVerification } from '../../src/plan/schema.js';
import { CleanupError } from '../../src/run/cleanup.js';
import {
  APPLICATION_LOG_FILE,
  BEHAVIORAL_LOG_FILE,
  RUNTIME_ARTIFACT_DIR,
  RUNTIME_RESULT_FILE,
  runRuntimeCheck,
  type RuntimeCheckResult,
} from '../../src/verify/runtime.js';
import { RUNTIME_READINESS_TIMEOUT_SECONDS } from '../../src/verify/runtime-policy.js';
import { ATTEMPT_LABEL, newAttemptId, runtimeContainerName } from '../../src/volume/naming.js';
import {
  createWorkspaceVolume,
  removeVolume,
  workspaceMount,
} from '../../src/volume/workspace.js';
import { runtimeImages } from '../helpers/images.js';

/** A dependency-free HTTP application: the runtime check is what is under test, not npm. */
const SERVER = `
const http = require('node:http');
const port = Number(process.env.PORT);
const host = process.env.HOST;

http
  .createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      return;
    }
    if (request.url === '/orders') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ id: 1 }]));
      return;
    }
    response.writeHead(404);
    response.end();
  })
  .listen(port, host, () => {
    console.log('listening on ' + host + ':' + port);
  });
`;

/** Reaches the application by container name over Docker DNS. No host port is published. */
const CHECKER = `
const url = process.env.ENACTMENT_APP_URL;
if (!url) {
  console.error('ENACTMENT_APP_URL is not set');
  process.exit(2);
}

require('node:http')
  .get(url + '/orders', (response) => {
    let body = '';
    response.on('data', (chunk) => (body += chunk));
    response.on('end', () => {
      const orders = JSON.parse(body);
      if (orders.length !== 1) {
        console.error('unexpected orders: ' + body);
        process.exit(1);
      }
      console.log('checker reached ' + url + ' and read ' + body);
    });
  })
  .on('error', (error) => {
    console.error('checker could not reach ' + url + ': ' + error.message);
    process.exit(1);
  });
`;

/** Proves the runtime network has no route off the Docker host and carries no credential. */
const ISOLATION_CHECKER = `
const fs = require('node:fs');

const findings = { auth: fs.existsSync('/run/agent-auth'), proxyEnv: [], canary: 'unreachable' };
for (const key of Object.keys(process.env)) {
  if (/proxy|token|codex|anthropic|openai|api_key/i.test(key)) findings.proxyEnv.push(key);
}

const request = require('node:http').get('http://example.com', () => {
  findings.canary = 'reachable';
  done();
});
request.on('error', () => done());
request.setTimeout(5000, () => {
  request.destroy();
  done();
});

let finished = false;
function done() {
  if (finished) return;
  finished = true;
  console.log(JSON.stringify(findings));
  const isolated = !findings.auth && findings.proxyEnv.length === 0 && findings.canary === 'unreachable';
  process.exit(isolated ? 0 : 1);
}
`;

const CRASHING_SERVER = `
console.error('cannot bind: configuration missing');
process.exit(1);
`;

const FAILING_CHECKER = `
console.error('behavioral expectation not met');
process.exit(1);
`;

async function tarOf(files: Record<string, string>): Promise<Buffer> {
  const packer = pack();
  const chunks: Buffer[] = [];
  const collected = new Promise<Buffer>((resolve, reject) => {
    packer.on('data', (chunk: Buffer) => chunks.push(chunk));
    packer.on('end', () => resolve(Buffer.concat(chunks)));
    packer.on('error', reject);
  });

  for (const [path, content] of Object.entries(files)) {
    packer.entry({ name: path, mode: 0o644, type: 'file' }, content);
  }
  packer.finalize();

  return collected;
}

function runtime(overrides: Partial<RuntimeVerification> = {}): RuntimeVerification {
  return {
    start_command: ['node', 'src/server.js'],
    port: 3000,
    readiness_path: '/health',
    behavioral_commands: [['node', 'enactment-checks/orders.js']],
    ...overrides,
  };
}

async function labelled(kind: 'container' | 'network', attempt: string): Promise<string[]> {
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', `label=${ATTEMPT_LABEL}=${attempt}`]
      : ['network', 'ls', '-q', '--filter', `label=${ATTEMPT_LABEL}=${attempt}`];

  const { stdout } = await execa('docker', args);
  return stdout.split('\n').filter((line) => line !== '');
}

let images: RuntimeImages;
let root: string;
const volumes: string[] = [];
const attempts: string[] = [];

beforeAll(async () => {
  images = await runtimeImages();
  root = await mkdtemp(join(tmpdir(), 'enactment-runtime-docker-'));
}, 600_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  // Every case, success or failure, leaves no runtime-labelled container or network.
  for (const attempt of attempts.splice(0)) {
    expect(await labelled('container', attempt)).toEqual([]);
    expect(await labelled('network', attempt)).toEqual([]);
  }
  await Promise.all(volumes.splice(0).map((name) => removeVolume(name)));
});

async function check(
  files: Record<string, string>,
  overrides: Partial<Parameters<typeof runRuntimeCheck>[0]> = {},
): Promise<{ result: RuntimeCheckResult; artifactDir: string; attempt: string }> {
  const attempt = newAttemptId();
  attempts.push(attempt);

  const volume = await createWorkspaceVolume(attempt, await tarOf(files), images);
  volumes.push(volume);

  const artifactDir = await mkdtemp(join(root, 'artifacts-'));

  const result = await runRuntimeCheck({
    attempt,
    runtime: runtime(),
    mounts: [workspaceMount(volume)],
    images,
    artifactDir,
    graceSeconds: 2,
    ...overrides,
  });

  return { result, artifactDir, attempt };
}

function artifact(artifactDir: string, name: string): Promise<string> {
  return readFile(join(artifactDir, RUNTIME_ARTIFACT_DIR, name), 'utf8');
}

describe('runtime check', () => {
  it(
    'control: an application becomes ready and a checker reaches it over Docker DNS',
    async () => {
      const { result, artifactDir, attempt } = await check({
        'src/server.js': SERVER,
        'enactment-checks/orders.js': CHECKER,
      });

      expect(result.status).toBe('pass');
      expect(result.stage).toBeUndefined();
      expect(result.url).toBe(`http://${runtimeContainerName(attempt)}:3000`);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]?.exitCode).toBe(0);

      expect(await artifact(artifactDir, APPLICATION_LOG_FILE)).toContain('listening on 0.0.0.0:3000');
      expect(await artifact(artifactDir, BEHAVIORAL_LOG_FILE)).toContain('checker reached');

      const stored = JSON.parse(
        await artifact(artifactDir, RUNTIME_RESULT_FILE),
      ) as RuntimeCheckResult;
      expect(stored.status).toBe('pass');
      expect(stored.verifierImage).toBe(images.verifier.id);
    },
    300_000,
  );

  it(
    'isolation control: neither container can reach the internet, a proxy or a credential',
    async () => {
      const { result, artifactDir } = await check(
        { 'src/server.js': SERVER, 'enactment-checks/isolation.js': ISOLATION_CHECKER },
        { runtime: runtime({ behavioral_commands: [['node', 'enactment-checks/isolation.js']] }) },
      );

      expect(result.status).toBe('pass');
      const log = await artifact(artifactDir, BEHAVIORAL_LOG_FILE);
      expect(log).toContain('"canary":"unreachable"');
      expect(log).toContain('"auth":false');
      expect(log).toContain('"proxyEnv":[]');
    },
    300_000,
  );

  it(
    'failure control: an application that exits immediately fails fast, with its reason logged',
    async () => {
      const { result, artifactDir } = await check({
        'src/server.js': CRASHING_SERVER,
        'enactment-checks/orders.js': CHECKER,
      });

      expect(result.status).toBe('fail');
      expect(result.stage).toBe('readiness');
      expect(result.readiness.applicationExited).toBe(true);
      expect(result.commands).toEqual([]);
      expect(await artifact(artifactDir, APPLICATION_LOG_FILE)).toContain(
        'cannot bind: configuration missing',
      );

      // The point of the fix: a dead application is not worth a 60-second readiness budget.
      // Measured on the probe's own duration, so a loaded daemon cannot make it lie.
      expect(result.readiness.durationMs).toBeLessThan(RUNTIME_READINESS_TIMEOUT_SECONDS * 1000);
    },
    300_000,
  );

  it(
    'failure control: a failing checker leaves its output and stops the check',
    async () => {
      const { result, artifactDir } = await check(
        {
          'src/server.js': SERVER,
          'enactment-checks/orders.js': FAILING_CHECKER,
          'enactment-checks/never.js': CHECKER,
        },
        {
          runtime: runtime({
            behavioral_commands: [
              ['node', 'enactment-checks/orders.js'],
              ['node', 'enactment-checks/never.js'],
            ],
          }),
        },
      );

      expect(result.status).toBe('fail');
      expect(result.stage).toBe('behavioral');
      expect(result.commands).toHaveLength(1);
      expect(await artifact(artifactDir, BEHAVIORAL_LOG_FILE)).toContain(
        'behavioral expectation not met',
      );
      expect(await artifact(artifactDir, BEHAVIORAL_LOG_FILE)).not.toContain('checker reached');
    },
    300_000,
  );

  it(
    'cleanup control: an interrupted check still removes its container and network',
    async () => {
      const attempt = newAttemptId();
      attempts.push(attempt);

      const volume = await createWorkspaceVolume(
        attempt,
        await tarOf({ 'src/server.js': SERVER, 'enactment-checks/orders.js': CHECKER }),
        images,
      );
      volumes.push(volume);

      const failure = await runRuntimeCheck({
        attempt,
        runtime: runtime(),
        mounts: [workspaceMount(volume)],
        images,
        artifactDir: await mkdtemp(join(root, 'artifacts-')),
        graceSeconds: 2,
        // Stands in for a process interrupted mid-check: the application is already up.
        run: () => Promise.reject(new Error('interrupted')),
      }).catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('interrupted');
      expect(failure).not.toBeInstanceOf(CleanupError);
    },
    300_000,
  );
});
