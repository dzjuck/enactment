import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

async function sourceFiles(): Promise<{ name: string; content: string }[]> {
  const entries = (await readdir(SRC, { withFileTypes: true, recursive: true })).filter((entry) =>
    entry.isFile(),
  );

  return await Promise.all(
    entries.map(async (entry) => ({
      name: join(entry.parentPath.slice(SRC.length), entry.name),
      content: await readFile(join(entry.parentPath, entry.name), 'utf8'),
    })),
  );
}

/**
 * An attempt workspace is disposable: it is built from the export, it belongs to one attempt,
 * and nothing downstream ever reads it again once the attempt has failed. Restoring it before
 * deleting it is work whose only product is a claim, so the claim is what has to go — a
 * manifest that reports a restoration nobody needed is worse than one that reports none.
 */
describe('failed workspaces are disposed, not restored', () => {
  it('offers no restoration hook on the test injection seam', async () => {
    const inject = await readFile(join(SRC, 'run/inject.ts'), 'utf8');

    expect(inject).not.toContain('restoreWorkspace');
  });

  it('never restores the agent workspace from the orchestrator', async () => {
    const orchestrator = await readFile(join(SRC, 'run/orchestrator.ts'), 'utf8');

    expect(orchestrator).not.toContain('restoreWorkspace');
    expect(orchestrator).not.toContain('restoration');
  });

  it('emits no restoration field from anywhere in the production source', async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(file.content, file.name).not.toContain('restoration');
    }
  });

  it('keeps workspace restore for the verifier, which needs a copy of the snapshot', async () => {
    const verify = await readFile(join(SRC, 'verify/run.ts'), 'utf8');

    // The one legitimate restore: seeding the verifier's own disposable volume.
    expect(verify).toContain('restoreWorkspace');
  });
});
