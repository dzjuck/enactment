/**
 * Minimal ustar reader, enough to inspect what `git archive` produces.
 * Reads the bytes exactly as written, with no normalization of its own.
 */

export type TarEntryType = 'file' | 'directory' | 'symlink';

export interface TarEntry {
  path: string;
  type: TarEntryType;
  mode: number;
  size: number;
  linkPath: string;
  content: Buffer;
}

const BLOCK = 512;

function field(header: Buffer, offset: number, length: number): string {
  const slice = header.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim();
}

function octal(header: Buffer, offset: number, length: number): number {
  const raw = field(header, offset, length);
  return raw === '' ? 0 : Number.parseInt(raw, 8);
}

export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];

  for (let offset = 0; offset + BLOCK <= archive.length; ) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;

    const size = octal(header, 124, 12);
    const typeflag = String.fromCharCode(header.readUInt8(156));
    const dataStart = offset + BLOCK;
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    // Global (`g`) and extended (`x`) pax headers describe the next entry, not a file.
    if (typeflag === 'g' || typeflag === 'x') continue;

    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const path = prefix === '' ? name : `${prefix}/${name}`;

    const type =
      typeflag === '5'
        ? 'directory'
        : typeflag === '2'
          ? 'symlink'
          : typeflag === '0' || typeflag === '\0'
            ? 'file'
            : undefined;
    if (type === undefined) {
      throw new Error(`unsupported tar entry type ${JSON.stringify(typeflag)} for ${path}`);
    }

    entries.push({
      path: type === 'directory' ? path.replace(/\/$/, '') : path,
      type,
      mode: octal(header, 100, 8),
      size,
      linkPath: field(header, 157, 100),
      content: archive.subarray(dataStart, dataStart + size),
    });
  }

  return entries;
}
