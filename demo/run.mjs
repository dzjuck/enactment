/* global process */

import { chmod, cp, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { execa } from 'execa';

import { AGENT_GID, AGENT_UID, NODE_BASE_IMAGE } from '../dist/config/pins.js';
import {
  resolveImageId,
  resolveRuntimeImages,
} from '../dist/docker/images.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEMO_ROOT = fileURLToPath(new URL('.', import.meta.url));
const DEMO_AGENT_TAG = 'enactment/demo-agent:latest';
const DEMO_USAGE = 'usage: node demo/run.mjs <replay|live>';

export function parseDemoMode(value) {
  if (value !== 'replay' && value !== 'live') throw new Error(DEMO_USAGE);
  return value;
}

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

export async function resolveDemoMode(
  mode,
  { buildReplayImage = buildDemoAgent, resolveImages = resolveRuntimeImages } = {},
) {
  const selectedMode = parseDemoMode(mode);
  const productionImages = await resolveImages();

  if (selectedMode === 'live') {
    return {
      images: productionImages,
      injection: undefined,
      credentials: 'production',
      demoImageId: undefined,
      productionImages,
    };
  }

  const demoImageId = await buildReplayImage();
  const images = {
    ...productionImages,
    codex: { role: 'codex', id: demoImageId },
    claude: { role: 'claude', id: demoImageId },
  };

  return {
    images,
    injection: { codex: images.codex, claude: images.claude },
    credentials: 'placeholder',
    demoImageId,
    productionImages,
  };
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

async function artifactTree(root, maxDepth = 4) {
  const lines = [];

  const walk = async (directory, depth) => {
    if (depth > maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

    for (const entry of entries) {
      lines.push(`${'  '.repeat(depth)}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory() && depth < maxDepth) {
        await walk(join(directory, entry.name), depth + 1);
      }
    }
  };

  await walk(root, 1);
  return lines.join('\n');
}

async function writeTour({ mode, write, result, repoPath, stateDirectory, artifactDir, baseCommit }) {
  const planRoot = join(artifactDir, 'task-summary');

  if (result.exitCode !== 0) {
    const failedStep = result.report?.failure?.step;
    const step = result.report?.steps?.find((entry) => entry.id === failedStep);
    const attempt = step?.attempts?.at(-1)?.id;
    write(`\nrepo       ${repoPath}\n`);
    write(`state      ${stateDirectory}\n`);
    write(`artifacts  ${planRoot}\n`);
    if (failedStep !== undefined && attempt !== undefined) {
      write(`evidence   ${join(planRoot, 'steps', failedStep, attempt, 'run-1')}\n`);
    }
    return;
  }

  const commits = await git(repoPath, [
    'log',
    '--reverse',
    '--format=%B',
    `${baseCommit}..enactment/task-summary`,
  ]);
  const diffstat = await git(repoPath, [
    'diff',
    '--stat',
    `${baseCommit}..enactment/task-summary`,
  ]);

  write(`\ncommits\n${indent(commits)}\n`);
  write(`\ndiffstat\n${indent(diffstat)}\n`);
  write(`\nartifacts\n${await artifactTree(planRoot)}\n`);
  write(
    mode === 'replay'
      ? 'agent     recorded replay; no provider was called\n'
      : 'agent     live providers; results are nondeterministic\n',
  );
}

function attachDemoPaths(error, demoPaths) {
  if (demoPaths === undefined) return error;
  if (!(error instanceof Error)) return Object.assign(new Error(String(error)), { demoPaths });

  Object.defineProperty(error, 'demoPaths', { value: demoPaths, enumerable: false });
  return error;
}

export async function runDemo({ mode, write }) {
  const selectedMode = parseDemoMode(mode);
  write(
    selectedMode === 'replay'
      ? 'mode      replay; recorded answers; no provider will be called\n'
      : 'mode      live; real credentials and provider quota will be used\n',
  );

  let demoPaths;
  try {
    return await runDemoWorkflow({
      selectedMode,
      write,
      onPaths: (paths) => {
        demoPaths = paths;
      },
    });
  } catch (error) {
    throw attachDemoPaths(error, demoPaths);
  }
}

async function runDemoWorkflow({ selectedMode, write, onPaths }) {
  const [{ runPlan }, { execute }] = await Promise.all([
    import('../dist/run/coordinator.js'),
    import('../dist/run/production.js'),
  ]);
  const modeRuntime = await resolveDemoMode(selectedMode);
  const resolveImages = () => Promise.resolve(modeRuntime.images);

  const root = await mkdtemp(join(tmpdir(), 'enactment-demo-'));
  const repoPath = join(root, 'repo');
  const stateDirectory = join(root, 'state');
  const artifactDir = join(root, 'artifacts');
  const storeDirectory = selectedMode === 'replay' ? join(root, 'store') : undefined;
  const sourceCodexHome = selectedMode === 'replay' ? join(root, 'auth', 'codex') : undefined;
  const claudeTokenFile =
    selectedMode === 'replay' ? join(root, 'auth', 'claude', 'token') : undefined;
  const dependencyCacheDirectory = join(DEMO_ROOT, '.cache', 'deps');
  const manifestPath = join(root, 'execution-manifest.yml');
  onPaths({ root, repoPath, stateDirectory, artifactDir, manifestPath });

  await cp(join(DEMO_ROOT, 'repo'), repoPath, { recursive: true });
  await git(repoPath, ['init', '--initial-branch=main']);
  await git(repoPath, ['config', 'user.name', 'Enactment Demo']);
  await git(repoPath, ['config', 'user.email', 'demo@enactment.invalid']);
  await git(repoPath, ['add', '.']);
  await git(repoPath, ['commit', '-m', 'Initial task board']);
  const baseCommit = await git(repoPath, ['rev-parse', 'HEAD']);

  if (sourceCodexHome !== undefined && claudeTokenFile !== undefined) {
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
  }

  const prepared = await execute(
    {
      kind: 'prepare',
      planFile: join(DEMO_ROOT, 'plan.yml'),
      repoPath,
      output: manifestPath,
      stateDirectory,
      ...(storeDirectory === undefined ? {} : { storeDirectory }),
      dependencyCacheDirectory,
    },
    { resolveImages },
  );
  if (prepared.exitCode !== 0) {
    const message =
      typeof prepared.report === 'object' &&
      prepared.report !== null &&
      'message' in prepared.report &&
      typeof prepared.report.message === 'string'
        ? `: ${prepared.report.message}`
        : '';
    throw new Error(`prepare failed${message}`);
  }

  const result = await execute(
    {
      kind: 'run',
      manifestPath,
      repoPath,
      artifactDir,
      stateDirectory,
      ...(sourceCodexHome === undefined ? {} : { sourceCodexHome }),
      ...(storeDirectory === undefined ? {} : { storeDirectory }),
      dependencyCacheDirectory,
    },
    {
      resolveImages,
      progress: write,
      ...(modeRuntime.injection === undefined
        ? {}
        : {
            coordinate: (options) =>
              runPlan({
                ...options,
                claudeTokenFile,
                injection: modeRuntime.injection,
              }),
          }),
    },
  );

  await writeTour({
    mode: selectedMode,
    write,
    result,
    repoPath,
    stateDirectory,
    artifactDir,
    baseCommit,
  });

  return {
    ...result,
    root,
    repoPath,
    stateDirectory,
    artifactDir,
    manifestPath,
    baseCommit,
    ...(modeRuntime.demoImageId === undefined ? {} : { demoImageId: modeRuntime.demoImageId }),
    productionImages: modeRuntime.productionImages,
  };
}

function conciseError(error) {
  const message = stripVTControlCharacters(error instanceof Error ? error.message : String(error));
  return message.split(/\r?\n/, 1)[0]?.trim() || 'unknown error';
}

function writeDemoFailure(write, error) {
  write(`demo failed  ${conciseError(error)}\n`);

  const paths =
    typeof error === 'object' && error !== null && 'demoPaths' in error
      ? error.demoPaths
      : undefined;
  if (typeof paths !== 'object' || paths === null) return;

  if ('root' in paths && typeof paths.root === 'string') write(`root         ${paths.root}\n`);
  if ('repoPath' in paths && typeof paths.repoPath === 'string') {
    write(`repo         ${paths.repoPath}\n`);
  }
  if ('stateDirectory' in paths && typeof paths.stateDirectory === 'string') {
    write(`state        ${paths.stateDirectory}\n`);
  }
  if ('artifactDir' in paths && typeof paths.artifactDir === 'string') {
    write(`artifacts    ${join(paths.artifactDir, 'task-summary')}\n`);
  }
  if ('manifestPath' in paths && typeof paths.manifestPath === 'string') {
    write(`manifest     ${paths.manifestPath}\n`);
  }
}

export async function runDemoMain({ mode, write, run = runDemo }) {
  try {
    return await run({ mode, write });
  } catch (error) {
    writeDemoFailure(write, error);
    return { exitCode: 1 };
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runDemoMain({
    mode: process.argv.length === 3 ? process.argv[2] : undefined,
    write: (text) => {
      process.stderr.write(text);
    },
  });
  process.exitCode = result.exitCode;
}
