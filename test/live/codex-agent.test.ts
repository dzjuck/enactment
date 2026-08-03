import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROXY_RECORDS_FILE } from '../../src/proxy/container.js';
import { runProduction } from '../../src/run/production.js';
import { runtimeImages } from '../helpers/images.js';
import { createM2Repo, git, removeRepo, type TargetRepo } from '../helpers/repo.js';

interface Manifest {
  runtime: Record<string, string>;
  usage?: {
    tests: { output_tokens: number };
    implementation: { output_tokens: number };
  };
  red?: { valid: boolean; category: string };
  green?: { valid: boolean };
  result: { status: string; cleanup_errors?: string[] };
}

interface ProxyRecord {
  hostname: string;
  allowed: boolean;
}

let repo: TargetRepo;
let root: string;
let planFile: string;
let artifacts: string;

beforeAll(async () => {
  repo = await createM2Repo();
  root = await mkdtemp(join(tmpdir(), 'harness-live-'));
  artifacts = join(root, 'artifacts');
  planFile = join(repo.dir, 'plan.yml');
}, 900_000);

afterAll(async () => {
  await removeRepo(repo.dir);
  // Only the repository and the artifacts are temporary. The credential store is not: it is
  // the harness's own persistent one, so a token Codex rotated during this run survives.
  await rm(root, { recursive: true, force: true });
});

/**
 * The whole production path, once, for real.
 *
 * §35 regression: Codex's inner sandbox is disabled. Bubblewrap aborts under the hardened
 * profile, so a real run that reaches a verified commit is what demonstrates the bypass works
 * end to end.
 *
 * It runs through `runProduction` — the same entry point the CLI uses — rather than
 * assembling the phases itself, for two reasons. The credential store is the persistent one,
 * so a rotated refresh token is copied back to where the next run will look for it instead of
 * into a temporary directory this suite then deletes. And a copy-back failure reaches the
 * report as a cleanup error, which fails the run: a live test that discarded a rotated token
 * and still went green is the exact failure this arrangement rules out.
 */
describe('real Codex tests-first run', () => {
  it('uses separate real agents to write tests and implementation, then commits both', async () => {
    const images = await runtimeImages();

    // No store or cache overrides: the persistent harness state is deliberately what is used.
    const report = await runProduction({ planFile, repoPath: repo.dir, artifactDir: artifacts });

    expect(report.cleanupErrors).toBeUndefined();
    expect(report.status).toBe('succeeded');
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);

    // Separate agents really wrote the declared test and implementation.
    const committed = await git(repo.dir, [
      'show',
      '--name-only',
      '--pretty=format:',
      report.commit ?? '',
    ]);
    expect(committed.split('\n').filter((line) => line !== '')).toEqual([
      'src/slugify.js',
      'test/slugify.test.js',
    ]);
    expect(await git(repo.dir, ['show', `${report.commit ?? ''}:src/slugify.js`])).not.toContain(
      'not implemented',
    );

    const manifest = JSON.parse(
      await readFile(join(artifacts, 'run-manifest.json'), 'utf8'),
    ) as Manifest;

    // What ran is what was recorded, for the real pinned image set.
    expect(manifest.runtime.agent_image_id).toBe(images.agent.id);
    expect(manifest.runtime.verifier_image_id).toBe(images.verifier.id);
    expect(manifest.runtime.setup_image_id).toBe(images.setup.id);
    expect(manifest.runtime.proxy_image_id).toBe(images.proxy.id);
    expect(manifest.usage?.tests.output_tokens).toBeGreaterThan(0);
    expect(manifest.usage?.implementation.output_tokens).toBeGreaterThan(0);
    expect(manifest.red).toMatchObject({ valid: true, category: 'missing_implementation' });
    expect(manifest.green).toMatchObject({ valid: true });
    expect(manifest.result.cleanup_errors).toBeUndefined();

    // §35 regression: the model was reached, and only through the allowlist.
    const records = (
      await Promise.all(
        ['tests', 'implementation'].map((phase) =>
          readFile(join(artifacts, phase, PROXY_RECORDS_FILE), 'utf8'),
        ),
      )
    )
      .flatMap((content) => content.split('\n'))
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as ProxyRecord);

    expect(records.some((record) => record.allowed)).toBe(true);
    expect(records.filter((record) => record.allowed).every((r) => r.hostname === 'chatgpt.com')).toBe(
      true,
    );
  }, 1_800_000);
});
