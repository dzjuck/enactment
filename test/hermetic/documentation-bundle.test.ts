import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DocumentationError,
  bundleRootFor,
  contextDirFor,
  documentationHash,
  readProvenance,
  verifyBundle,
  writeBundle,
  type DocumentationEntry,
} from '../../src/docs/bundle.js';

const SOURCES = [
  { url: 'https://example.com/api/openapi.json', path: 'example/openapi.json' },
  { url: 'https://example.com/guide.md', path: 'guide.md' },
];

const CONFIG = { sources: SOURCES };

function entries(overrides: Partial<Record<string, Buffer>> = {}): DocumentationEntry[] {
  return SOURCES.map((source, index) => ({
    ...source,
    bytes: overrides[source.path] ?? Buffer.from(`body ${index}\n`, 'utf8'),
    fetchedAt: '2026-01-01T00:00:00.000Z',
  }));
}

let root: string;

beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'harness-docs-')), 'documentation');
});

describe('writeBundle', () => {
  it('writes the declared files byte-identically, plus an index and provenance', async () => {
    await writeBundle(root, entries());

    for (const [index, source] of SOURCES.entries()) {
      const stored = await readFile(join(root, 'context', 'files', source.path));
      expect(stored).toEqual(Buffer.from(`body ${index}\n`, 'utf8'));
    }

    expect(await readFile(join(root, 'context', 'index.md'), 'utf8')).toContain('example/openapi.json');
    expect((await readProvenance(root)).sources.map((entry) => entry.path)).toEqual([
      'example/openapi.json',
      'guide.md',
    ]);
  });

  it('leaves directories 0755 and files 0644, so uid 1001 can read the mount', async () => {
    await writeBundle(root, entries());

    const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

    expect(await mode(root)).toBe(0o755);
    expect(await mode(join(root, 'context'))).toBe(0o755);
    expect(await mode(join(root, 'context', 'files', 'example'))).toBe(0o755);
    expect(await mode(join(root, 'context', 'files', 'guide.md'))).toBe(0o644);
    expect(await mode(join(root, 'context', 'index.md'))).toBe(0o644);
    expect(await mode(join(root, 'provenance.json'))).toBe(0o644);
  });

  it('records url, hash and size per source in provenance with its fetch time', async () => {
    await writeBundle(root, entries());

    const provenance = await readProvenance(root);
    expect(provenance.sources[1]).toEqual({
      path: 'guide.md',
      url: 'https://example.com/guide.md',
      hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      bytes: 7,
      fetched_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('refuses a storage path that escapes the bundle root', async () => {
    for (const path of ['../escape.json', '/etc/passwd']) {
      await expect(writeBundle(root, [{ url: 'https://example.com/a', path, bytes: Buffer.from('x'), fetchedAt: '2026-01-01T00:00:00.000Z' }])).rejects.toBeInstanceOf(
        DocumentationError,
      );
    }
  });
});

describe('context/index.md', () => {
  it('lists every source sorted by path with its URL, hash and size, and no timestamp', async () => {
    await writeBundle(root, [...entries()].reverse());

    const index = await readFile(join(root, 'context', 'index.md'), 'utf8');
    const provenance = await readProvenance(root);

    expect(index.indexOf('example/openapi.json')).toBeLessThan(index.indexOf('guide.md'));
    for (const source of provenance.sources) {
      expect(index).toContain(source.url);
      expect(index).toContain(source.hash);
      expect(index).toContain(String(source.bytes));
    }

    expect(index).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(index).not.toContain('fetched_at');
    expect(index).toMatch(/reference data/i);
  });
});

describe('documentationHash', () => {
  it('is stable when only fetched_at changes', async () => {
    await writeBundle(root, entries());
    const before = await documentationHash(contextDirFor(root));

    await rm(root, { recursive: true, force: true });
    await writeBundle(
      root,
      entries().map((entry) => ({ ...entry, fetchedAt: '2026-07-07T12:00:00.000Z' })),
    );

    expect(await documentationHash(contextDirFor(root))).toBe(before);
  });

  it.each([
    ['a mounted file changes bytes', join('context', 'files', 'guide.md'), 'edited\n'],
    ['the index changes', join('context', 'index.md'), '# tampered\n'],
  ])('changes when %s', async (_label, relative, content) => {
    await writeBundle(root, entries());
    const before = await documentationHash(contextDirFor(root));

    await writeFile(join(root, relative), content);

    expect(await documentationHash(contextDirFor(root))).not.toBe(before);
  });

  it('changes when a mounted file moves to another path', async () => {
    await writeBundle(root, entries());
    const before = await documentationHash(contextDirFor(root));

    await rm(root, { recursive: true, force: true });
    await writeBundle(
      root,
      entries().map((entry) =>
        entry.path === 'guide.md' ? { ...entry, path: 'docs/guide.md' } : entry,
      ),
    );

    expect(await documentationHash(contextDirFor(root))).not.toBe(before);
  });
});

describe('verifyBundle', () => {
  it('reports an absent bundle rather than a corrupt one', async () => {
    await expect(verifyBundle(root, CONFIG)).resolves.toEqual({ present: false });
  });

  it('accepts an untouched bundle and returns its hash', async () => {
    await writeBundle(root, entries());

    expect(await verifyBundle(root, CONFIG)).toEqual({
      present: true,
      hash: await documentationHash(contextDirFor(root)),
    });
  });

  async function verifyError(): Promise<DocumentationError> {
    try {
      await verifyBundle(root, CONFIG);
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentationError);
      return error as DocumentationError;
    }
    throw new Error('expected the bundle to be rejected, but it verified');
  }

  it('rejects a missing provenance file', async () => {
    await writeBundle(root, entries());
    await rm(join(root, 'provenance.json'));

    expect((await verifyError()).reason).toBe('provenance_missing');
  });

  it('rejects a malformed provenance file', async () => {
    await writeBundle(root, entries());
    await writeFile(join(root, 'provenance.json'), '{ not json');

    expect((await verifyError()).reason).toBe('provenance_malformed');
  });

  it.each([
    ['a null source', { sources: [null] }],
    [
      'an invalid source field',
      {
        sources: [
          {
            path: 'guide.md',
            url: 'https://example.com/guide.md',
            hash: 'not-a-hash',
            bytes: -1,
            fetched_at: 'not-a-time',
          },
        ],
      },
    ],
  ])('rejects valid JSON with %s as malformed provenance', async (_label, provenance) => {
    await writeBundle(root, entries());
    await writeFile(join(root, 'provenance.json'), JSON.stringify(provenance));

    expect((await verifyError()).reason).toBe('provenance_malformed');
  });

  it('rejects provenance that does not describe the declared sources', async () => {
    await writeBundle(root, [entries()[0] as DocumentationEntry]);

    expect((await verifyError()).reason).toBe('sources_changed');
  });

  it('rejects a missing declared file', async () => {
    await writeBundle(root, entries());
    await rm(join(root, 'context', 'files', 'guide.md'));

    const error = await verifyError();
    expect(error.reason).toBe('file_missing');
    expect(error.message).toContain('guide.md');
  });

  it('rejects an edited declared file', async () => {
    await writeBundle(root, entries());
    await writeFile(join(root, 'context', 'files', 'guide.md'), 'edited\n');

    const error = await verifyError();
    expect(error.reason).toBe('file_modified');
    expect(error.message).toContain('guide.md');
  });

  it('rejects an edited index', async () => {
    await writeBundle(root, entries());
    await writeFile(join(root, 'context', 'index.md'), '# tampered\n');

    expect((await verifyError()).reason).toBe('file_modified');
  });

  it('rejects an undeclared extra file under the context', async () => {
    await writeBundle(root, entries());
    await writeFile(join(root, 'context', 'files', 'extra.md'), 'extra\n');

    const error = await verifyError();
    expect(error.reason).toBe('unexpected_file');
    expect(error.message).toContain('extra.md');
  });

  it('names the whole-directory fix in every failure message', async () => {
    await writeBundle(root, entries());
    await rm(join(root, 'context', 'files', 'guide.md'));

    expect((await verifyError()).message).toMatch(/delete/i);
  });
});

describe('bundleRootFor', () => {
  it('places the bundle beside the plan file', () => {
    expect(bundleRootFor('/plans/weather/plan.yml')).toBe('/plans/weather/documentation');
    expect(contextDirFor('/plans/weather/documentation')).toBe('/plans/weather/documentation/context');
  });
});
