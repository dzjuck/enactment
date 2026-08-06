import { createHash } from 'node:crypto';

import type { RuntimeImages } from '../docker/images.js';
import { runContainer, type RunOptions, type RunResult } from '../docker/run.js';
import { withPhaseNetworks } from '../net/manage.js';
import type { DocumentationSource } from '../plan/schema.js';
import {
  proxyEnvironment,
  withProxy,
  type ProxyContainerOptions,
  type ProxyHandle,
} from '../proxy/container.js';
import type { ProxyRecord } from '../proxy/record.js';
import { attemptLabels, newAttemptId } from '../volume/naming.js';
import { DOCUMENTATION_MAX_BYTES, DOCUMENTATION_MAX_MB, DOCUMENTATION_TIMEOUT_SECONDS } from './policy.js';

/** The harness could not perform the download: Docker, the container, or its output. */
export class DocumentationDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentationDownloadError';
  }
}

export type SourceFailureReason =
  | 'status'
  | 'fetch_failed'
  | 'too_large'
  | 'hash_mismatch'
  | 'not_utf8'
  | 'binary_content'
  | 'html_content';

/** One declared source could not be accepted. Distinct from an infrastructure failure. */
export class DocumentationSourceError extends DocumentationDownloadError {
  readonly reason: SourceFailureReason;
  readonly url: string;

  constructor(reason: SourceFailureReason, url: string, message: string) {
    super(message);
    this.name = 'DocumentationSourceError';
    this.reason = reason;
    this.url = url;
  }
}

export interface DownloadedSource extends DocumentationSource {
  bytes: Buffer;
  hash: string;
  contentType?: string;
}

export interface DocumentationDownloadResult {
  sources: DownloadedSource[];
  proxyRecords: ProxyRecord[];
}

/**
 * The fixed downloader, as `node --use-env-proxy -e`.
 *
 * `--use-env-proxy` makes `fetch` dial `HTTPS_PROXY`; without it, it goes direct. That is the
 * whole reason there is no hand-written CONNECT client and no new image to approve. Nothing
 * from the plan is interpolated into this source: the cap and the URLs arrive as argv.
 *
 * The container fetches; the host decides. The byte cap is the only rule enforced here, because
 * it is the only one that has to stop a response in flight — every content rule is applied on
 * the host, where the bytes themselves are the evidence and no container claim is trusted.
 *
 * Each source produces exactly one NDJSON line, and the script always exits 0: a non-zero exit
 * means the harness could not run the download at all.
 */
export const DOWNLOADER_SOURCE = `
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const cap = Number(process.argv[1]);
const urls = process.argv.slice(2);
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');

(async () => {
  let total = 0;

  for (const url of urls) {
    try {
      const response = await fetch(url, { redirect: 'manual' });

      if (response.status !== 200) {
        emit({
          url,
          ok: false,
          reason: 'status',
          status: response.status,
          location: response.headers.get('location'),
        });
        continue;
      }

      if (response.body === null) throw new Error('response has no body');

      // Breaking out of the iterator destroys the stream, so an oversized source stops being
      // read rather than being read and then rejected. The cap bounds what is held here.
      const chunks = [];
      let sourceBytes = 0;
      let capped = false;
      for await (const chunk of Readable.fromWeb(response.body)) {
        if (total + sourceBytes + chunk.length > cap) {
          capped = true;
          break;
        }
        sourceBytes += chunk.length;
        chunks.push(chunk);
      }
      if (capped) {
        emit({ url, ok: false, reason: 'too_large' });
        continue;
      }
      total += sourceBytes;

      const body = Buffer.concat(chunks);
      emit({
        url,
        ok: true,
        status: 200,
        contentType: response.headers.get('content-type'),
        bytes: sourceBytes,
        hash: createHash('sha256').update(body).digest('hex'),
        body: body.toString('base64'),
      });
    } catch (error) {
      emit({ url, ok: false, reason: 'fetch_failed', detail: String((error && error.message) || error) });
    }
  }
})();
`;

interface DownloadRecord {
  url?: unknown;
  ok?: unknown;
  status?: unknown;
  location?: unknown;
  detail?: unknown;
  reason?: unknown;
  contentType?: unknown;
  bytes?: unknown;
  hash?: unknown;
  body?: unknown;
}

export interface DocumentationDownloadOptions {
  sources: readonly DocumentationSource[];
  images: RuntimeImages;
  /** Attempt-scoped like every non-`run` command: labelled resources, no global sweep (§5). */
  attempt?: string;
  graceSeconds?: number;
  /** Injectable Docker steps, so every failure path is testable without a daemon. */
  run?: (spec: Parameters<typeof runContainer>[0], options: RunOptions) => Promise<RunResult>;
  proxy?: <T>(
    options: ProxyContainerOptions,
    use: (handle: ProxyHandle) => Promise<T>,
  ) => Promise<T>;
}

/** The exact-hostname allowlist is derived from the declared URLs; there is no second list. */
export function derivedHosts(sources: readonly DocumentationSource[]): string[] {
  return [...new Set(sources.map((source) => new URL(source.url).hostname))];
}

function parseRecords(stdout: string): DownloadRecord[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as DownloadRecord;
      } catch {
        throw new DocumentationDownloadError(
          `the downloader produced output that is not NDJSON: ${line.slice(0, 200)}`,
        );
      }
    });
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

const BINARY_SIGNATURES = [
  Buffer.from('%PDF-'),
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x1f, 0x8b]),
  Buffer.from('BZh'),
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]),
];

function hasBinarySignature(bytes: Buffer): boolean {
  return BINARY_SIGNATURES.some(
    (signature) =>
      bytes.byteLength >= signature.byteLength &&
      bytes.subarray(0, signature.byteLength).equals(signature),
  );
}

function acceptBody(source: DocumentationSource, record: DownloadRecord): DownloadedSource {
  const bytes = Buffer.from(String(record.body ?? ''), 'base64');

  if (bytes.byteLength > DOCUMENTATION_MAX_BYTES) {
    throw new DocumentationSourceError(
      'too_large',
      source.url,
      `${source.url} exceeds the fixed ${String(DOCUMENTATION_MAX_MB)} MB documentation limit`,
    );
  }

  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== record.hash) {
    throw new DocumentationSourceError(
      'hash_mismatch',
      source.url,
      `${source.url} did not hash to what the downloader reported; the bytes are not trusted`,
    );
  }

  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw new DocumentationSourceError(
      'not_utf8',
      source.url,
      `${source.url} is not UTF-8 text; V1 stores documentation as text only`,
    );
  }

  if (text.includes('\0') || hasBinarySignature(bytes)) {
    throw new DocumentationSourceError(
      'binary_content',
      source.url,
      `${source.url} is binary content; V1 stores documentation as text only`,
    );
  }

  const head = text.trimStart().slice(0, 20).toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    throw new DocumentationSourceError(
      'html_content',
      source.url,
      `${source.url} is an HTML page; declare a machine-readable source instead`,
    );
  }

  return {
    ...source,
    bytes,
    hash: `sha256:${hash}`,
    ...(typeof record.contentType === 'string' ? { contentType: record.contentType } : {}),
  };
}

function rejectFailure(source: DocumentationSource, record: DownloadRecord): never {
  const reason = String(record.reason);

  if (reason === 'status') {
    const location = typeof record.location === 'string' ? `; Location: ${record.location}` : '';
    throw new DocumentationSourceError(
      'status',
      source.url,
      `${source.url} returned HTTP ${String(record.status)}${location}; redirects are never followed, declare the final URL`,
    );
  }

  if (reason === 'too_large') {
    throw new DocumentationSourceError(
      'too_large',
      source.url,
      `${source.url} exceeds the fixed ${String(DOCUMENTATION_MAX_MB)} MB documentation limit`,
    );
  }

  if (reason === 'fetch_failed') {
    throw new DocumentationSourceError(
      'fetch_failed',
      source.url,
      `${source.url} could not be fetched: ${String(record.detail)}`,
    );
  }

  throw new DocumentationDownloadError(
    `the downloader reported an unknown outcome for ${source.url}: ${JSON.stringify(record)}`,
  );
}

function verify(
  sources: readonly DocumentationSource[],
  records: readonly DownloadRecord[],
): DownloadedSource[] {
  if (records.length !== sources.length) {
    throw new DocumentationDownloadError(
      `the downloader reported ${String(records.length)} results for ${String(sources.length)} declared sources`,
    );
  }

  let total = 0;

  return sources.map((source, index) => {
    const record = records[index] as DownloadRecord;

    if (record.url !== source.url) {
      throw new DocumentationDownloadError(
        `the downloader reported ${String(record.url)} where ${source.url} was declared`,
      );
    }

    if (record.ok !== true) return rejectFailure(source, record);

    const accepted = acceptBody(source, record);
    total += accepted.bytes.byteLength;
    if (total > DOCUMENTATION_MAX_BYTES) {
      throw new DocumentationSourceError(
        'too_large',
        source.url,
        `${source.url} pushes the complete bundle over the fixed ${String(DOCUMENTATION_MAX_MB)} MB documentation limit`,
      );
    }
    return accepted;
  });
}

/**
 * Fetch every declared source in one hardened container that can reach the declared hosts
 * through the CONNECT proxy and nothing else.
 *
 * No workspace, no dependency volume, no credential mount, no Docker socket. The container's
 * claims are evidence, not authority: every rule is re-checked here from the decoded bytes.
 */
export async function runDocumentationDownload(
  options: DocumentationDownloadOptions,
): Promise<DocumentationDownloadResult> {
  const attempt = options.attempt ?? newAttemptId();
  const run = options.run ?? runContainer;
  const proxy = options.proxy ?? withProxy;

  return withPhaseNetworks(attempt, 'documentation', (networks) =>
    proxy(
      {
        attempt,
        egressNetwork: networks['documentation-egress'] ?? '',
        outwardNetwork: networks['documentation-proxy-egress'] ?? '',
        allowlist: derivedHosts(options.sources),
        ports: [443],
        images: options.images,
      },
      async (handle) => {
        const result = await run(
          {
            image: options.images.verifier.id,
            argv: [
              'node',
              '--use-env-proxy',
              '-e',
              DOWNLOADER_SOURCE,
              String(DOCUMENTATION_MAX_BYTES),
              ...options.sources.map((source) => source.url),
            ],
            network: networks['documentation-egress'] ?? '',
            workdir: '/tmp',
            env: proxyEnvironment(handle),
            labels: attemptLabels(attempt, 'documentation'),
          },
          {
            timeoutSeconds: DOCUMENTATION_TIMEOUT_SECONDS,
            ...(options.graceSeconds === undefined ? {} : { graceSeconds: options.graceSeconds }),
          },
        );

        if (result.status === 'timeout') {
          throw new DocumentationDownloadError(
            `the documentation download exceeded ${String(DOCUMENTATION_TIMEOUT_SECONDS)}s and was terminated`,
          );
        }

        if (result.exitCode !== 0) {
          throw new DocumentationDownloadError(
            `the documentation downloader failed (${String(result.exitCode)}): ${result.stderr || result.stdout}`,
          );
        }

        return {
          sources: verify(options.sources, parseRecords(result.stdout)),
          proxyRecords: await handle.records(),
        };
      },
    ),
  );
}
