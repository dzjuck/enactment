import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../src/artifacts/store.js';
import { dependencyCacheKey, installCommand, lockfileHash } from '../../src/deps/cache-key.js';
import { resolveRuntimeImages, type RuntimeImages } from '../../src/docker/images.js';
import {
  verifyPlanHead,
  FINAL_VERIFICATION_ARTIFACT,
  type FinalVerificationResult,
} from '../../src/verify/final.js';
import { DEPENDENCY_CACHE } from '../helpers/deps.js';
import { commitAll, createM2Repo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';

const LABEL = 'enactment.attempt';

let repo: TargetRepo;
let images: RuntimeImages;
let root: string;
let head: string;
const dirs: string[] = [];

beforeAll(async () => {
  images = await resolveRuntimeImages();
  repo = await createM2Repo();
  root = await mkdtemp(join(tmpdir(), 'enactment-final-'));

  // A committed marker the working tree does not have, so a run that verified the working
  // tree instead of the commit would be visible.
  await writeFile(join(repo.dir, 'committed-marker.txt'), 'from the plan head\n');
  head = await commitAll(repo.dir, 'plan head');
  await rm(join(repo.dir, 'committed-marker.txt'));
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function labelled(
  kind: 'container' | 'volume' | 'network',
  attempt: string,
): Promise<string[]> {
  const filter = `label=${LABEL}=${attempt}`;
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', filter]
      : [kind, 'ls', '-q', '--filter', filter];

  const { stdout } = await execa('docker', args);
  return stdout.split('\n').filter((line) => line !== '');
}

async function expectNoResources(attempt: string): Promise<void> {
  await expect(labelled('container', attempt)).resolves.toEqual([]);
  await expect(labelled('volume', attempt)).resolves.toEqual([]);
  await expect(labelled('network', attempt)).resolves.toEqual([]);
}

interface Run {
  result: FinalVerificationResult;
  artifacts: string;
  attempt: string;
}

async function run(
  commands: string[][],
  overrides: Partial<Parameters<typeof verifyPlanHead>[0]> = {},
): Promise<Run> {
  const artifacts = await scratch('enactment-final-artifacts-');
  const attempt = overrides.attempt ?? `final-${Math.random().toString(16).slice(2, 10)}`;

  const result = await verifyPlanHead({
    repoPath: repo.dir,
    head,
    commands,
    artifactDir: artifacts,
    snapshots: new ArtifactStore(join(root, 'snapshots')),
    dependencyCacheDirectory: DEPENDENCY_CACHE,
    images,
    ...overrides,
    attempt,
  });

  return { result, artifacts, attempt };
}

describe('offline final branch verification', () => {
  it('runs every declared command against an immutable export of the head', async () => {
    const { result, artifacts, attempt } = await run([
      ['node', '-e', "require('node:fs').readFileSync('committed-marker.txt')"],
      ['npx', '--no-install', 'vitest', 'run', '--globals', 'test/existing.test.js'],
    ]);

    expect(result.status).toBe('pass');
    expect(result.head).toBe(head);
    expect(result.commands).toHaveLength(2);
    expect(result.commands.every((command) => command.exitCode === 0)).toBe(true);

    const artifact = JSON.parse(
      await readFile(join(artifacts, FINAL_VERIFICATION_ARTIFACT), 'utf8'),
    ) as FinalVerificationResult & { runtime: Record<string, string> };

    expect(artifact.head).toBe(head);
    expect(artifact.dependencyCacheKey).toMatch(/^sha256:/);
    expect(artifact.runtime.verifier_image_id).toBe(images.verifier.id);
    expect(artifact.runtime.setup_image_id).toBe(images.setup.id);
    await expectNoResources(attempt);
  }, 900_000);

  it('gives the verifier no network, no provider auth and no canonical git', async () => {
    const { result } = await run([
      [
        'node',
        '-e',
        [
          "const fs = require('node:fs');",
          "if (fs.existsSync('.git')) { throw new Error('canonical .git is present'); }",
          "if (fs.existsSync('/run/agent-auth/auth.json')) { throw new Error('provider auth is present'); }",
        ].join(''),
      ],
      // No egress: a DNS lookup cannot resolve on `network_mode: none`.
      [
        'node',
        '-e',
        "require('node:dns').lookup('chatgpt.com', (error) => { process.exit(error ? 0 : 1); })",
      ],
    ]);

    expect(result.status).toBe('pass');
  }, 900_000);

  it('cannot write back to the plan branch', async () => {
    const before = await git(repo.dir, ['rev-parse', 'HEAD']);
    const listedBefore = await git(repo.dir, ['for-each-ref', '--format=%(refname) %(objectname)']);

    // A path the exported tree actually has, so the write succeeds and the test is about
    // where it lands rather than about whether it happened.
    const { result } = await run([
      ['node', '-e', "require('node:fs').writeFileSync('README.md', 'tampered\\n')"],
    ]);

    expect(result.status).toBe('pass');
    expect(await git(repo.dir, ['rev-parse', 'HEAD'])).toBe(before);
    expect(await git(repo.dir, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(
      listedBefore,
    );
    expect(await git(repo.dir, ['show', `${head}:README.md`])).not.toContain('tampered');
  }, 900_000);

  it('stops at the first failing command, records it, and creates no commit', async () => {
    const commitsBefore = await git(repo.dir, ['rev-list', '--all', '--count']);

    const { result, artifacts, attempt } = await run([
      ['node', '-e', 'process.exit(3)'],
      ['node', '-e', "require('node:fs').writeFileSync('/tmp/never-ran', 'x')"],
    ]);

    expect(result.status).toBe('fail');
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.exitCode).toBe(3);
    expect(await git(repo.dir, ['rev-list', '--all', '--count'])).toBe(commitsBefore);

    const artifact = JSON.parse(
      await readFile(join(artifacts, FINAL_VERIFICATION_ARTIFACT), 'utf8'),
    ) as FinalVerificationResult;
    expect(artifact.status).toBe('fail');
    await expectNoResources(attempt);
  }, 900_000);

  it('records a timeout as a failed result and leaves nothing behind', async () => {
    const { result, attempt } = await run(
      [['node', '-e', 'setTimeout(() => {}, 600000)']],
      { timeoutSeconds: 5, graceSeconds: 2 },
    );

    expect(result.status).toBe('timeout');
    await expectNoResources(attempt);
  }, 900_000);

  it('keys dependencies off the final head lockfile and the clean cache contract', async () => {
    const { result } = await run([['node', '--version']]);

    expect(result.dependencyCacheKey).toBe(
      dependencyCacheKey({
        setupImageId: images.setup.id,
        lockfileHash: await lockfileHash(repo.dir, head),
        installCommand: installCommand('denied'),
        lifecycleScripts: 'denied',
      }),
    );
  }, 900_000);

  it('leaves nothing behind when it is interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    const attempt = `final-interrupt-${Math.random().toString(16).slice(2, 10)}`;

    await expect(
      run([['node', '--version']], { attempt, signal: controller.signal }),
    ).rejects.toThrow();

    await expectNoResources(attempt);
  }, 900_000);
});
