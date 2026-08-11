import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeImages } from '../../src/docker/images.js';
import { readProvenance } from '../../src/docs/bundle.js';
import {
  DocumentationSourceError,
  type DocumentationDownloadOptions,
  type DocumentationDownloadResult,
} from '../../src/docs/download.js';
import { CliUsageError, parseCommand } from '../../src/run/options.js';
import { execute, type CommandResult } from '../../src/run/production.js';

const IMAGES: RuntimeImages = {
  codex: { role: 'codex', id: `sha256:${'a'.repeat(64)}` },
  claude: { role: 'claude', id: `sha256:${'e'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'b'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'c'.repeat(64)}` },
  reviewer: { role: 'reviewer', id: `sha256:${'9'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'d'.repeat(64)}` },
};

const BODIES: Record<string, string> = {
  'open-meteo/openapi.json': '{"openapi":"3.1.0"}',
  'example/reference.md': '# reference\n',
};

const STEPS = [
  'steps:',
  '  - type: task',
  '    complexity: low',
  '    risk: standard',
  '    id: only-step',
  '    observable_behavior: Do the thing.',
  '    implementation_paths:',
  '      - only-step.txt',
  '    verification:',
  '      commands:',
  '        - ["node", "--version"]',
  'final_verification:',
  '  commands:',
  '    - ["node", "--version"]',
  '',
].join('\n');

const DOCUMENTATION = [
  'documentation:',
  '  sources:',
  '    - url: https://open-meteo.com/en/docs/openapi.json',
  '      path: open-meteo/openapi.json',
  '    - url: https://example.com/reference.md',
  '      path: example/reference.md',
  '',
].join('\n');

const PLAN = `version: 1\nid: docs-plan\n${DOCUMENTATION}${STEPS}`;
const PLAN_WITHOUT_DOCUMENTATION = `version: 1\nid: docs-plan\n${STEPS}`;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Space {
  planFile: string;
  bundle: string;
  downloads: DocumentationDownloadOptions[];
}

async function workspace(plan = PLAN): Promise<Space> {
  const dir = await mkdtemp(join(tmpdir(), 'enactment-docs-cli-'));
  dirs.push(dir);

  const planFile = join(dir, 'plan.yml');
  await writeFile(planFile, plan);

  return { planFile, bundle: join(dir, 'documentation'), downloads: [] };
}

function docs(
  space: Space,
  download?: (options: DocumentationDownloadOptions) => Promise<DocumentationDownloadResult>,
): Promise<CommandResult> {
  return execute(parseCommand(['docs', space.planFile], {}), {
    resolveImages: () => Promise.resolve(IMAGES),
    download:
      download ??
      ((options) => {
        space.downloads.push(options);
        return Promise.resolve({
          sources: options.sources.map((source) => ({
            ...source,
            bytes: Buffer.from(BODIES[source.path] ?? '', 'utf8'),
            hash: 'sha256:unused',
          })),
          proxyRecords: [{ hostname: new URL(options.sources[0]?.url ?? '').hostname }] as never,
        });
      }),
  });
}

interface DocsReport {
  documentation?: string;
  hash?: string;
  sources?: { path: string; url: string; hash: string; bytes: number; fetched: boolean }[];
  proxy_records?: unknown[];
  error?: string;
  message?: string;
}

describe('docs command parsing', () => {
  it('takes a plan file and nothing else', () => {
    expect(parseCommand(['docs', 'plan.yml'], {})).toMatchObject({
      kind: 'docs',
      planFile: 'plan.yml',
    });
  });

  it.each([
    ['a missing plan file', ['docs']],
    ['a surplus positional', ['docs', 'plan.yml', 'extra']],
    ['a repo option', ['docs', 'plan.yml', '--repo', '/repo']],
    ['an output option', ['docs', 'plan.yml', '--output', 'm.yml']],
  ])('rejects %s', (_label, argv) => {
    expect(() => parseCommand(argv, {})).toThrow(CliUsageError);
  });

  it('leaves the existing commands unchanged', () => {
    expect(parseCommand(['run', 'm.yml', '--repo', '/repo'], {})).toMatchObject({ kind: 'run' });
    expect(
      parseCommand(['prepare', 'plan.yml', '--repo', '/repo', '--output', 'm.yml'], {}),
    ).toMatchObject({ kind: 'prepare' });
  });
});

describe('enactment docs', () => {
  it('fetches every source, writes the bundle and reports what it stored', async () => {
    const space = await workspace();
    const result = await docs(space);
    const report = result.report as DocsReport;

    expect(result.exitCode).toBe(0);
    expect(report.documentation).toBe(space.bundle);
    expect(report.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.sources).toEqual([
      {
        path: 'example/reference.md',
        url: 'https://example.com/reference.md',
        hash: expect.stringMatching(/^sha256:/),
        bytes: BODIES['example/reference.md']?.length,
        fetched: true,
      },
      {
        path: 'open-meteo/openapi.json',
        url: 'https://open-meteo.com/en/docs/openapi.json',
        hash: expect.stringMatching(/^sha256:/),
        bytes: BODIES['open-meteo/openapi.json']?.length,
        fetched: true,
      },
    ]);
    expect(report.proxy_records).toHaveLength(1);

    expect(await readFile(join(space.bundle, 'context', 'files', 'example/reference.md'), 'utf8')).toBe(
      BODIES['example/reference.md'],
    );
  });

  it('reuses a valid bundle without fetching anything again', async () => {
    const space = await workspace();
    const first = await docs(space);
    const before = await readProvenance(space.bundle);

    space.downloads.length = 0;
    const second = await docs(space);
    const report = second.report as DocsReport;

    expect(space.downloads).toEqual([]);
    expect(second.exitCode).toBe(0);
    expect(report.hash).toBe((first.report as DocsReport).hash);
    expect(report.sources?.every((source) => !source.fetched)).toBe(true);
    expect(report.proxy_records).toBeUndefined();
    expect(await readProvenance(space.bundle)).toEqual(before);
  });

  it('refetches everything once the whole directory is deleted', async () => {
    const space = await workspace();
    await docs(space);

    await rm(space.bundle, { recursive: true, force: true });
    space.downloads.length = 0;

    const report = (await docs(space)).report as DocsReport;

    expect(space.downloads).toHaveLength(1);
    expect(report.sources?.every((source) => source.fetched)).toBe(true);
  });

  it.each([
    [
      'a missing file',
      async (bundle: string) => rm(join(bundle, 'context', 'files', 'example/reference.md')),
    ],
    [
      'an edited file',
      async (bundle: string) =>
        writeFile(join(bundle, 'context', 'files', 'example/reference.md'), 'tampered\n'),
    ],
    [
      'an undeclared extra file',
      async (bundle: string) => writeFile(join(bundle, 'context', 'files', 'extra.md'), 'extra\n'),
    ],
  ])('refuses to repair %s, and starts no container', async (_label, damage) => {
    const space = await workspace();
    await docs(space);
    await damage(space.bundle);
    space.downloads.length = 0;

    const result = await docs(space);
    const report = result.report as DocsReport;

    expect(result.exitCode).toBe(1);
    expect(space.downloads).toEqual([]);
    expect(report.message).toMatch(/delete/i);
  });

  it('reports that a plan without documentation has nothing to download', async () => {
    const space = await workspace(PLAN_WITHOUT_DOCUMENTATION);
    const result = await docs(space);

    expect(result.exitCode).toBe(0);
    expect(space.downloads).toEqual([]);
    expect((result.report as DocsReport).sources).toEqual([]);
  });

  it('writes no bundle when a source fails, and exits non-zero', async () => {
    const space = await workspace();

    const result = await docs(space, () =>
      Promise.reject(
        new DocumentationSourceError('status', 'https://example.com/reference.md', 'returned HTTP 404'),
      ),
    );

    expect(result.exitCode).toBe(1);
    expect((result.report as DocsReport).message).toContain('404');
    await expect(readFile(join(space.bundle, 'provenance.json'))).rejects.toThrow();
  });
});
