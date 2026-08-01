import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  dependencyCacheKey,
  installCommand,
  lockfileHash,
  type DependencyCacheInputs,
} from '../../src/deps/cache-key.js';
import { commitAll, createTargetRepo, removeRepo, type TargetRepo } from '../helpers/repo.js';

const inputs: DependencyCacheInputs = {
  setupImageDigest: `sha256:${'a'.repeat(64)}`,
  lockfileHash: `sha256:${'b'.repeat(64)}`,
  installCommand: ['npm', 'ci', '--ignore-scripts'],
  lifecycleScripts: 'denied',
};

describe('dependencyCacheKey', () => {
  it('is stable when nothing changes', () => {
    expect(dependencyCacheKey(inputs)).toBe(dependencyCacheKey({ ...inputs }));
    expect(dependencyCacheKey(inputs)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ['setupImageDigest', { setupImageDigest: `sha256:${'c'.repeat(64)}` }],
    ['lockfileHash', { lockfileHash: `sha256:${'d'.repeat(64)}` }],
    ['installCommand', { installCommand: ['npm', 'ci'] }],
    ['lifecycleScripts', { lifecycleScripts: 'allowed' as const }],
  ])('changes when %s changes', (_name, override) => {
    expect(dependencyCacheKey({ ...inputs, ...override })).not.toBe(dependencyCacheKey(inputs));
  });

  it('derives the install command from the lifecycle-script policy', () => {
    expect(installCommand('denied')).toContain('--ignore-scripts');
    expect(installCommand('allowed')).not.toContain('--ignore-scripts');
  });
});

describe('lockfileHash', () => {
  let repo: TargetRepo;

  beforeEach(async () => {
    repo = await createTargetRepo();
  });

  afterEach(async () => {
    await removeRepo(repo.dir);
  });

  it('does not change when an unrelated source file changes', async () => {
    const before = await lockfileHash(repo.dir, repo.commit);

    await writeFile(join(repo.dir, 'src/slugify.js'), 'export const slugify = () => "x";\n');
    const commit = await commitAll(repo.dir, 'Edit source');

    expect(await lockfileHash(repo.dir, commit)).toBe(before);
  });

  it('changes when the lockfile changes', async () => {
    const before = await lockfileHash(repo.dir, repo.commit);

    await writeFile(join(repo.dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
    const commit = await commitAll(repo.dir, 'Edit lockfile');

    expect(await lockfileHash(repo.dir, commit)).not.toBe(before);
  });
});
