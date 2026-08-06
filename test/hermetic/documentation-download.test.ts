import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IMAGE_ROLES } from '../../src/config/pins.js';
import type { ContainerSpec } from '../../src/docker/args.js';
import type { RuntimeImages } from '../../src/docker/images.js';
import type { RunOptions, RunResult } from '../../src/docker/run.js';
import {
  DOCUMENTATION_MAX_BYTES,
  DOCUMENTATION_TIMEOUT_SECONDS,
} from '../../src/docs/policy.js';
import {
  DocumentationDownloadError,
  DocumentationSourceError,
  DOWNLOADER_SOURCE,
  runDocumentationDownload,
  type DocumentationDownloadResult,
} from '../../src/docs/download.js';
import type { ProxyContainerOptions, ProxyHandle } from '../../src/proxy/container.js';
import { OwnershipError } from '../../src/run/ownership.js';
import { ATTEMPT_LABEL, ROLE_LABEL } from '../../src/volume/naming.js';

const { dockerCalls, dockerFailure, fakeExeca } = vi.hoisted(() => {
  const recorded: string[][] = [];
  const failure: { match?: string } = {};

  const fake = (_file: string, args: string[]): Promise<{ exitCode: number; stderr: string }> => {
    recorded.push(args);

    if (failure.match !== undefined && args.join(' ').includes(failure.match)) {
      return Promise.reject(
        Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), {
          exitCode: 1,
          stderr: 'container is still attached',
        }),
      );
    }

    return Promise.resolve({ exitCode: 0, stderr: '' });
  };

  return { dockerCalls: recorded, dockerFailure: failure, fakeExeca: fake };
});

vi.mock('execa', () => ({ execa: fakeExeca }));

const IMAGES = Object.fromEntries(
  IMAGE_ROLES.map((role, index) => [role, { role, id: `sha256:${String(index + 1).repeat(64)}` }]),
) as RuntimeImages;

const ATTEMPT = 'docs-1';

const SOURCES = [
  { url: 'https://open-meteo.com/en/docs/openapi.json', path: 'open-meteo/openapi.json' },
  { url: 'https://open-meteo.com/guide.md', path: 'guide.md' },
  { url: 'https://example.com/reference.md', path: 'example/reference.md' },
];

const PROXY_RECORDS = [{ host: 'open-meteo.com', allowed: true }];
const execFileAsync = promisify(execFile);

function ok(overrides: Partial<RunResult> = {}): RunResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutBytes: Buffer.alloc(0),
    durationMs: 5,
    status: 'completed',
    ...overrides,
  };
}

function line(url: string, body: string, overrides: Record<string, unknown> = {}): string {
  const bytes = Buffer.from(body, 'utf8');

  return JSON.stringify({
    url,
    ok: true,
    status: 200,
    contentType: 'application/json',
    bytes: bytes.byteLength,
    hash: createHash('sha256').update(bytes).digest('hex'),
    body: bytes.toString('base64'),
    ...overrides,
  });
}

function stdoutFor(bodies: string[]): string {
  return `${SOURCES.map((source, index) => line(source.url, bodies[index] as string)).join('\n')}\n`;
}

interface Recorder {
  ran: { spec: ContainerSpec; options: RunOptions }[];
  proxy: ProxyContainerOptions[];
}

let recorder: Recorder;

beforeEach(() => {
  dockerCalls.length = 0;
  delete dockerFailure.match;
  recorder = { ran: [], proxy: [] };
});

type Overrides = Partial<Parameters<typeof runDocumentationDownload>[0]>;

function download(overrides: Overrides = {}): Promise<DocumentationDownloadResult> {
  return runDocumentationDownload({
    attempt: ATTEMPT,
    sources: SOURCES,
    images: IMAGES,
    run: (spec, options) => {
      recorder.ran.push({ spec, options });
      return Promise.resolve(ok({ stdout: stdoutFor(['{"a":1}', '# guide', '# reference']) }));
    },
    proxy: async (options, run) => {
      recorder.proxy.push(options);
      const handle: ProxyHandle = {
        name: 'proxy',
        host: 'proxy',
        port: 8888,
        records: () => Promise.resolve(PROXY_RECORDS as never),
      };
      return run(handle);
    },
    ...overrides,
  });
}

describe('the downloader container', () => {
  it('runs the fixed script with the byte cap and the validated URLs, under the documentation budget', async () => {
    await download();

    const { spec, options } = recorder.ran[0] as Recorder['ran'][number];

    expect(spec.argv).toEqual([
      'node',
      '--use-env-proxy',
      '-e',
      DOWNLOADER_SOURCE,
      String(DOCUMENTATION_MAX_BYTES),
      ...SOURCES.map((source) => source.url),
    ]);
    expect(options.timeoutSeconds).toBe(DOCUMENTATION_TIMEOUT_SECONDS);
  });

  it('uses the verifier image, the proxy environment and the internal documentation network', async () => {
    await download();

    const { spec } = recorder.ran[0] as Recorder['ran'][number];

    expect(spec.image).toBe(IMAGES.verifier.id);
    expect(spec.network).toBe(`ai-harness-net-${ATTEMPT}-documentation-egress`);
    expect(spec.env?.HTTPS_PROXY).toBe('http://proxy:8888');
  });

  it('mounts no workspace, no dependencies and no credentials, and is labelled for the sweep', async () => {
    await download();

    const { spec } = recorder.ran[0] as Recorder['ran'][number];

    expect(spec.mounts ?? []).toEqual([]);
    expect(JSON.stringify(spec)).not.toContain('agent-auth');
    expect(spec.labels).toEqual({ [ATTEMPT_LABEL]: ATTEMPT, [ROLE_LABEL]: 'documentation' });
  });

  it('creates the documentation phase networks and removes them again', async () => {
    await download();

    const created = dockerCalls.filter((args) => args[0] === 'network' && args[1] === 'create');
    const removed = dockerCalls.filter((args) => args[0] === 'network' && args[1] === 'rm');

    expect(created.map((args) => args.at(-1))).toEqual([
      `ai-harness-net-${ATTEMPT}-documentation-egress`,
      `ai-harness-net-${ATTEMPT}-documentation-proxy-egress`,
    ]);
    expect(created[0]).toContain('--internal');
    expect(created[1]).not.toContain('--internal');
    expect(removed).toHaveLength(2);
  });

  it('starts the proxy with exactly the distinct declared hostnames on port 443', async () => {
    await download();

    const [options] = recorder.proxy;
    expect(options?.allowlist).toEqual(['open-meteo.com', 'example.com']);
    expect(options?.ports).toEqual([443]);
  });

  it('returns the proxy records beside the downloaded sources', async () => {
    const result = await download();

    expect(result.proxyRecords).toEqual(PROXY_RECORDS);
  });

  it('writes response chunks progressively and emits the exact bytes', async () => {
    const fakeFetch = `
      global.fetch = async () => ({
        status: 200,
        headers: { get: () => 'text/plain' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from('first '));
            controller.enqueue(Buffer.from('second'));
            controller.close();
          },
        }),
        arrayBuffer: async () => { throw new Error('must not buffer the response'); },
      });
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '-e',
        `${fakeFetch}\n${DOWNLOADER_SOURCE}`,
        String(DOCUMENTATION_MAX_BYTES),
        'https://example.com/stream',
      ],
    );
    const record = JSON.parse(stdout) as { ok: boolean; body: string };

    expect(record.ok).toBe(true);
    expect(Buffer.from(record.body, 'base64').toString('utf8')).toBe('first second');
  });

  it('stops reading an oversized response instead of buffering it all', async () => {
    const cap = 64 * 1024;
    const chunkBytes = 16 * 1024;
    const totalChunks = 512;
    const fakeFetch = `
      let pulls = 0;
      const chunkBytes = ${String(chunkBytes)};
      const totalChunks = ${String(totalChunks)};
      process.on('exit', () => require('node:fs').writeSync(2, String(pulls)));
      global.fetch = async () => ({
        status: 200,
        headers: { get: () => 'text/plain' },
        body: new ReadableStream({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
            if (pulls === totalChunks) controller.close();
          },
        }),
        arrayBuffer: async () => {
          pulls = totalChunks;
          return new Uint8Array(chunkBytes * totalChunks).buffer;
        },
      });
    `;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['-e', `${fakeFetch}\n${DOWNLOADER_SOURCE}`, String(cap), 'https://example.com/large'],
    );

    expect(JSON.parse(stdout)).toMatchObject({ ok: false, reason: 'too_large' });
    expect(Number(stderr) * chunkBytes).toBeLessThan(chunkBytes * totalChunks);
  });
});

describe('result verification', () => {
  it('returns one result per source in declared order, with the bytes and a recomputed hash', async () => {
    const bodies = ['{"a":1}', '# guide', '# reference'];
    const result = await download({
      run: () => Promise.resolve(ok({ stdout: stdoutFor(bodies) })),
    });

    expect(result.sources.map((source) => source.path)).toEqual(SOURCES.map((source) => source.path));
    expect(result.sources.map((source) => source.bytes.toString('utf8'))).toEqual(bodies);
    expect(result.sources[0]?.hash).toBe(
      `sha256:${createHash('sha256').update(Buffer.from(bodies[0] as string)).digest('hex')}`,
    );
  });

  it('rejects a body whose reported hash does not match the bytes it carries', async () => {
    const stdout = `${[
      line(SOURCES[0]!.url, '{"a":1}', { hash: 'f'.repeat(64) }),
      line(SOURCES[1]!.url, '# guide'),
      line(SOURCES[2]!.url, '# reference'),
    ].join('\n')}\n`;

    await expect(download({ run: () => Promise.resolve(ok({ stdout })) })).rejects.toMatchObject({
      name: 'DocumentationSourceError',
      reason: 'hash_mismatch',
      url: SOURCES[0]!.url,
    });
  });

  it.each([
    [
      'a non-200 status',
      { ok: false, reason: 'status', status: 404 },
      'status',
      /404/,
    ],
    [
      'a redirect the downloader refused to follow',
      { ok: false, reason: 'status', status: 302, location: 'https://elsewhere.example/spec.json' },
      'status',
      /https:\/\/elsewhere\.example\/spec\.json/,
    ],
    [
      'a transport failure',
      { ok: false, reason: 'fetch_failed', detail: 'connect ECONNREFUSED' },
      'fetch_failed',
      /ECONNREFUSED/,
    ],
    [
      'a body over the fixed size cap',
      { ok: false, reason: 'too_large', bytes: DOCUMENTATION_MAX_BYTES + 1 },
      'too_large',
      /50/,
    ],
  ])('rejects %s, naming the source', async (_label, overrides, reason, message) => {
    const stdout = `${[
      JSON.stringify({ url: SOURCES[0]!.url, ...overrides }),
      line(SOURCES[1]!.url, '# guide'),
      line(SOURCES[2]!.url, '# reference'),
    ].join('\n')}\n`;

    const error = await download({ run: () => Promise.resolve(ok({ stdout })) }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DocumentationSourceError);
    expect((error as DocumentationSourceError).reason).toBe(reason);
    expect((error as Error).message).toContain(SOURCES[0]!.url);
    expect((error as Error).message).toMatch(message);
  });

  it.each([
    ['invalid UTF-8', Buffer.from([0xff, 0xfe, 0x41]), 'not_utf8'],
    ['a NUL byte', Buffer.from('ok\0bad', 'utf8'), 'binary_content'],
    ['a PDF', Buffer.from('%PDF-1.7\n1 0 obj\n', 'utf8'), 'binary_content'],
    ['a ZIP archive', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x61]), 'binary_content'],
    ['an HTML page', Buffer.from('<!DOCTYPE html>\n<html></html>', 'utf8'), 'html_content'],
    ['an HTML fragment', Buffer.from('<html><body>hi</body></html>', 'utf8'), 'html_content'],
  ])('rejects %s on the host, whatever the container reported', async (_label, body, reason) => {
    const stdout = `${[
      JSON.stringify({
        url: SOURCES[0]!.url,
        ok: true,
        status: 200,
        contentType: 'text/plain',
        bytes: body.byteLength,
        hash: createHash('sha256').update(body).digest('hex'),
        body: body.toString('base64'),
      }),
      line(SOURCES[1]!.url, '# guide'),
      line(SOURCES[2]!.url, '# reference'),
    ].join('\n')}\n`;

    await expect(download({ run: () => Promise.resolve(ok({ stdout })) })).rejects.toMatchObject({
      name: 'DocumentationSourceError',
      reason,
    });
  });

  it('rejects a body over the cap even when the container called it fine', async () => {
    const body = Buffer.alloc(DOCUMENTATION_MAX_BYTES + 1, 0x61);
    const stdout = `${[
      JSON.stringify({
        url: SOURCES[0]!.url,
        ok: true,
        status: 200,
        bytes: body.byteLength,
        hash: createHash('sha256').update(body).digest('hex'),
        body: body.toString('base64'),
      }),
      line(SOURCES[1]!.url, '# guide'),
      line(SOURCES[2]!.url, '# reference'),
    ].join('\n')}\n`;

    await expect(download({ run: () => Promise.resolve(ok({ stdout })) })).rejects.toMatchObject({
      reason: 'too_large',
    });
  });

  it('rejects sources that exceed the complete-bundle cap in aggregate', async () => {
    const first = 'a'.repeat(26 * 1024 * 1024);
    const second = 'b'.repeat(26 * 1024 * 1024);
    const stdout = `${[
      line(SOURCES[0]!.url, first),
      line(SOURCES[1]!.url, second),
      line(SOURCES[2]!.url, '# reference'),
    ].join('\n')}\n`;

    await expect(download({ run: () => Promise.resolve(ok({ stdout })) })).rejects.toMatchObject({
      reason: 'too_large',
      url: SOURCES[1]!.url,
    });
  });
});

describe('infrastructure failures', () => {
  it('reports unparseable stdout as a download failure, not a content failure', async () => {
    const error = await download({
      run: () => Promise.resolve(ok({ stdout: 'not ndjson\n' })),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DocumentationDownloadError);
    expect(error).not.toBeInstanceOf(DocumentationSourceError);
  });

  it('reports a missing result line as a download failure', async () => {
    const stdout = `${line(SOURCES[0]!.url, '{"a":1}')}\n`;

    await expect(download({ run: () => Promise.resolve(ok({ stdout })) })).rejects.toBeInstanceOf(
      DocumentationDownloadError,
    );
  });

  it('reports a container that fails to start as a download failure', async () => {
    await expect(
      download({ run: () => Promise.resolve(ok({ exitCode: 125, stderr: 'no such image' })) }),
    ).rejects.toBeInstanceOf(DocumentationDownloadError);
  });

  it('reports a timeout as a download failure naming the budget', async () => {
    const error = await download({
      run: () => Promise.resolve(ok({ status: 'timeout', exitCode: -1 })),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DocumentationDownloadError);
    expect((error as Error).message).toContain(String(DOCUMENTATION_TIMEOUT_SECONDS));
  });
});

describe('cleanup', () => {
  it('surfaces a network that could not be removed rather than reporting success', async () => {
    dockerFailure.match = 'network rm';

    await expect(download()).rejects.toBeTruthy();
  });

  it('keeps a download failure when cleanup fails too', async () => {
    dockerFailure.match = 'network rm';

    const error = await download({
      run: () => Promise.resolve(ok({ stdout: 'not ndjson\n' })),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OwnershipError);
    expect((error as OwnershipError).cause).toBeInstanceOf(DocumentationDownloadError);
  });
});
