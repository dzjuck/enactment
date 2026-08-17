/* global process */

import { chmod, cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

import { execa } from 'execa';

import { AGENT_GID, AGENT_UID, NODE_BASE_IMAGE } from '../dist/config/pins.js';
import {
  resolveImageId,
  resolveRuntimeImages,
} from '../dist/docker/images.js';
import { runPlan } from '../dist/run/coordinator.js';
import { execute } from '../dist/run/production.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEMO_ROOT = fileURLToPath(new URL('.', import.meta.url));
const DEMO_AGENT_TAG = 'enactment/demo-agent:latest';

async function git(repoPath, args) {
  const { stdout } = await execa('git', ['-C', repoPath, ...args]);
  return stdout.trim();
}

async function buildDemoAgent() {
  await execa(
    'docker',
    [
      'build',
      '--build-arg',
      `NODE_BASE_IMAGE=${NODE_BASE_IMAGE}`,
      '--build-arg',
      `AGENT_UID=${String(AGENT_UID)}`,
      '--build-arg',
      `AGENT_GID=${String(AGENT_GID)}`,
      '--file',
      'demo/agent/Dockerfile',
      '--tag',
      DEMO_AGENT_TAG,
      '.',
    ],
    { cwd: REPOSITORY_ROOT },
  );

  return resolveImageId(DEMO_AGENT_TAG);
}

export async function runDemo({ write }) {
  const demoImageId = await buildDemoAgent();
  const productionImages = await resolveRuntimeImages();
  const resolvedImages = {
    ...productionImages,
    codex: { role: 'codex', id: demoImageId },
    claude: { role: 'claude', id: demoImageId },
  };
  const resolveImages = () => Promise.resolve(resolvedImages);
  const injection = {
    codex: resolvedImages.codex,
    claude: resolvedImages.claude,
  };

  const root = await mkdtemp(join(tmpdir(), 'enactment-demo-'));
  const repoPath = join(root, 'repo');
  const stateDirectory = join(root, 'state');
  const artifactDir = join(root, 'artifacts');
  const storeDirectory = join(root, 'store');
  const sourceCodexHome = join(root, 'auth', 'codex');
  const claudeTokenFile = join(root, 'auth', 'claude', 'token');
  const dependencyCacheDirectory = join(DEMO_ROOT, '.cache', 'deps');
  const manifestPath = join(root, 'execution-manifest.yml');

  await cp(join(DEMO_ROOT, 'repo'), repoPath, { recursive: true });
  await git(repoPath, ['init', '--initial-branch=main']);
  await git(repoPath, ['config', 'user.name', 'Enactment Demo']);
  await git(repoPath, ['config', 'user.email', 'demo@enactment.invalid']);
  await git(repoPath, ['add', '.']);
  await git(repoPath, ['commit', '-m', 'Initial task board']);
  const baseCommit = await git(repoPath, ['rev-parse', 'HEAD']);

  await mkdir(sourceCodexHome, { recursive: true, mode: 0o700 });
  const codexAuthFile = join(sourceCodexHome, 'auth.json');
  await writeFile(
    codexAuthFile,
    `${JSON.stringify({ tokens: { access_token: 'demo-placeholder-token' } })}\n`,
    { mode: 0o600 },
  );
  await chmod(codexAuthFile, 0o600);

  await mkdir(dirname(claudeTokenFile), { recursive: true, mode: 0o700 });
  await chmod(dirname(claudeTokenFile), 0o700);
  await writeFile(claudeTokenFile, 'demo-placeholder-token\n', { mode: 0o600 });
  await chmod(claudeTokenFile, 0o600);

  const prepared = await execute(
    {
      kind: 'prepare',
      planFile: join(DEMO_ROOT, 'plan.yml'),
      repoPath,
      output: manifestPath,
      stateDirectory,
      storeDirectory,
      dependencyCacheDirectory,
    },
    { resolveImages },
  );
  if (prepared.exitCode !== 0) {
    throw new Error(`demo prepare failed: ${JSON.stringify(prepared.report)}`);
  }

  const result = await execute(
    {
      kind: 'run',
      manifestPath,
      repoPath,
      artifactDir,
      stateDirectory,
      sourceCodexHome,
      storeDirectory,
      dependencyCacheDirectory,
    },
    {
      resolveImages,
      progress: write,
      coordinate: (options) =>
        runPlan({
          ...options,
          claudeTokenFile,
          injection,
        }),
    },
  );

  return {
    ...result,
    root,
    repoPath,
    stateDirectory,
    artifactDir,
    manifestPath,
    baseCommit,
    demoImageId,
    productionImages,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runDemo({
    write: (text) => {
      process.stderr.write(text);
    },
  });
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  process.exitCode = result.exitCode;
}
