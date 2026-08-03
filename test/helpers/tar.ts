import { extract, pack } from 'tar-stream';

/**
 * Rewrite a workspace tar with extra files, keeping every existing entry.
 *
 * Recovery tests need a *verified acceptance candidate*: the tar a snapshot would have held
 * had the process survived. Building it from the parent export keeps it a real workspace
 * rather than a one-file archive that no diff would accept.
 */
export async function tarWithAdditions(
  base: Buffer,
  files: Record<string, string>,
): Promise<Buffer> {
  const packer = pack();
  const chunks: Buffer[] = [];
  const collected = new Promise<Buffer>((resolve, reject) => {
    packer.on('data', (chunk: Buffer) => chunks.push(chunk));
    packer.on('end', () => resolve(Buffer.concat(chunks)));
    packer.on('error', reject);
  });

  const extractor = extract();
  extractor.on('entry', (header, stream, next) => {
    stream.pipe(packer.entry(header, next));
  });

  await new Promise<void>((resolve, reject) => {
    extractor.on('finish', resolve);
    extractor.on('error', reject);
    extractor.end(base);
  });

  for (const [path, content] of Object.entries(files)) {
    packer.entry({ name: path, mode: 0o644, type: 'file' }, content);
  }

  packer.finalize();
  return await collected;
}
