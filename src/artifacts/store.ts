import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface StoredArtifact {
  /** `sha256:<hex>` of the content. */
  hash: string;
  path: string;
}

export function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * A content-addressed directory of immutable artifacts. Stored files are read-only: an
 * accepted snapshot must not be editable in place by anything downstream.
 */
export class ArtifactStore {
  constructor(private readonly root: string) {}

  pathFor(hash: string, extension = ''): string {
    return join(this.root, `${hash.replace('sha256:', '')}${extension}`);
  }

  async put(bytes: Buffer, extension = ''): Promise<StoredArtifact> {
    const hash = sha256(bytes);
    const path = this.pathFor(hash, extension);

    await mkdir(this.root, { recursive: true });

    // Write then rename, so a reader never sees a partial artifact.
    const staging = `${path}.staging`;
    await writeFile(staging, bytes);
    await rename(staging, path);
    await chmod(path, 0o444);

    return { hash, path };
  }

  async read(hash: string, extension = ''): Promise<Buffer> {
    return readFile(this.pathFor(hash, extension));
  }
}
