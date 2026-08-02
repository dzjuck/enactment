import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { extract } from 'tar-stream';

const isZero = (byte: number): boolean => byte === 0;

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export type ArchiveEntryType = 'file' | 'directory' | 'symlink';

export interface ArchiveEntry {
  /** The decoded archive path, exactly as written. Never trimmed, never reconstructed. */
  path: string;
  type: ArchiveEntryType;
  mode: number;
  size: number;
  /** The decoded link target for a symlink; empty otherwise. Never trimmed. */
  linkPath: string;
  content: Buffer;
}

/**
 * The entry types a source tree may contain. Everything else — hard links, devices, FIFOs —
 * is refused rather than normalized into something that looks like a file.
 */
const SUPPORTED: Record<string, ArchiveEntryType> = {
  file: 'file',
  'contiguous-file': 'file',
  directory: 'directory',
  symlink: 'symlink',
};

/**
 * Decode a tar archive into entries, using `tar-stream` for the header formats Git and GNU
 * tar actually emit.
 *
 * A hand-rolled ustar reader is not sufficient here, and the failure is silent. `git archive`
 * writes a PAX extended header for any path it cannot fit in the ustar `name`/`prefix` fields
 * and names the real entry `<sha>.data`; a reader that skips the PAX record reports that
 * placeholder as the file's path, so a change is attributed to a file that does not exist.
 * GNU tar — the format workspace snapshots use — solves the same problem with `L`/`K` long-name
 * records instead. Both are decoded here, and neither name nor link target is trimmed: a
 * filename ending in a space is a different file from one that does not.
 */
/** Two 512-byte zero blocks: the end-of-archive marker every tar writer emits. */
const END_OF_ARCHIVE = 1024;

export async function readArchive(tar: Buffer): Promise<ArchiveEntry[]> {
  // Checked before parsing, because the parser cannot tell a short archive from a complete
  // one: a stream cut at a block boundary ends cleanly and yields a plausible — but
  // incomplete — entry list. Only the terminator distinguishes the two.
  if (tar.length < END_OF_ARCHIVE || !tar.subarray(tar.length - END_OF_ARCHIVE).every(isZero)) {
    throw new ArchiveError(
      'archive is truncated: it does not end with the end-of-archive marker',
    );
  }

  const entries: ArchiveEntry[] = [];
  const parser = extract();

  parser.on('entry', (header, stream, next) => {
    const type = SUPPORTED[header.type ?? ''];

    if (type === undefined) {
      // The real decoded path, so the refusal names the entry the archive actually contains.
      const failure = new ArchiveError(
        `unsupported archive entry type "${String(header.type)}" for ${header.name}`,
      );
      stream.resume();
      parser.destroy(failure);
      return;
    }

    const chunks: Buffer[] = [];

    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', (error: Error) => parser.destroy(error));
    stream.on('end', () => {
      const content = Buffer.concat(chunks);

      entries.push({
        // Directory entries carry a trailing slash; the path itself does not.
        path: type === 'directory' ? header.name.replace(/\/$/, '') : header.name,
        type,
        mode: header.mode ?? 0,
        size: header.size ?? content.length,
        linkPath: header.linkname ?? '',
        content,
      });

      next();
    });
  });

  // A truncated archive rejects here rather than yielding a plausibly short entry list.
  await pipeline(Readable.from([tar]), parser);

  return entries;
}
