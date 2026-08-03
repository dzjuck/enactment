import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

  /**
   * Everything the store holds. Empty when it has never been written to.
   *
   * Paths are returned rather than hashes alone because callers store with different
   * extensions — workspace snapshots bare, exported trees as `.tar` — so a hash is not enough
   * to name the file it lives in.
   */
  async list(): Promise<StoredArtifact[]> {
    try {
      return (await readdir(this.root))
        .filter((name) => !name.endsWith('.staging'))
        .map((name) => ({
          hash: `sha256:${name.replace(/\.[^.]*$/, '')}`,
          path: join(this.root, name),
        }));
    } catch {
      return [];
    }
  }

  /** Retention is a termination rule (§11); this is how a terminated attempt gives up space. */
  async remove(artifact: StoredArtifact): Promise<void> {
    await rm(artifact.path, { force: true });
  }
}
