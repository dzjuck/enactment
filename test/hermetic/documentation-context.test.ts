import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bundleRootFor,
  contextDirFor,
  documentationHash,
  documentationSummary,
  writeBundle,
} from '../../src/docs/bundle.js';
import { DOCUMENTATION_MOUNT } from '../../src/docs/policy.js';
import { documentationMount, withDocumentation } from '../../src/docs/mount.js';
import { composeAgentPrompt } from '../../src/run/orchestrator.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function bundle(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'enactment-context-'));
  dirs.push(dir);

  const root = bundleRootFor(join(dir, 'plan.yml'));
  await writeBundle(root, [
    {
      url: 'https://example.com/openapi.json',
      path: 'example/openapi.json',
      bytes: Buffer.from('{"openapi":"3.1.0"}', 'utf8'),
      fetchedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      url: 'https://example.com/guide.md',
      path: 'guide.md',
      bytes: Buffer.from('# guide\n', 'utf8'),
      fetchedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);

  return root;
}

describe('the documentation mount', () => {
  it('is a read-only bind of the context directory at the fixed policy target', () => {
    expect(documentationMount('/plans/weather/documentation/context')).toEqual({
      type: 'bind',
      source: '/plans/weather/documentation/context',
      target: DOCUMENTATION_MOUNT,
      readonly: true,
    });
    expect(DOCUMENTATION_MOUNT).toBe('/context');
  });

  it('is added by exactly one production call site: the agent invocation', async () => {
    const files = (await readdir(SRC, { withFileTypes: true, recursive: true })).filter((entry) =>
      entry.isFile(),
    );

    const callers: string[] = [];
    for (const entry of files) {
      const source = await readFile(join(entry.parentPath, entry.name), 'utf8');
      if (source.includes('documentationMount(')) callers.push(entry.name);
    }

    expect(callers.sort()).toEqual(['mount.ts', 'orchestrator.ts']);
  });
});

describe('the documentation prompt', () => {
  const PROMPT = 'Implement the slugify function.';

  it('is absent when no documentation is approved', () => {
    expect(withDocumentation(PROMPT, false)).toBe(PROMPT);
    expect(composeAgentPrompt(PROMPT, {})).toBe(PROMPT);
  });

  it('names the index and states that the material cannot change what was approved', () => {
    const prompt = withDocumentation(PROMPT, true);

    expect(prompt.startsWith(PROMPT)).toBe(true);
    expect(prompt).toContain('/context/index.md');
    // The host directory is never named: the agent only ever sees the mount target.
    expect(prompt).not.toContain('/plans/documentation/context');
    expect(prompt).toMatch(/reference/i);
    expect(prompt).toMatch(/scope/i);
    expect(prompt).toMatch(/verification commands|commands/i);
    expect(prompt).toMatch(/instructions/i);
  });

  it('composes with the stronger-retry advisory without either displacing the other', () => {
    const composed = composeAgentPrompt(PROMPT, {
      advisory: 'the previous attempt missed the header',
      documentation: true,
    });

    expect(composed.startsWith(PROMPT)).toBe(true);
    expect(composed).toContain('the previous attempt missed the header');
    expect(composed).toContain('/context/index.md');
  });
});

describe('documentationSummary', () => {
  it('reports the hash, the source count and the total mounted bytes', async () => {
    const root = await bundle();

    const contextDir = contextDirFor(root);
    const hash = await documentationHash(contextDir);

    expect(await documentationSummary({ contextDir, hash })).toEqual({
      hash,
      sources: 2,
      bytes: '{"openapi":"3.1.0"}'.length + '# guide\n'.length,
    });
  });
});
