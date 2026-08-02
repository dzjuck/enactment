import { execa } from 'execa';

import { buildStubAgent } from '../helpers/stub-agent.js';

/**
 * Prepare the shared, mutable artifacts the docker suite depends on — once, before any file
 * runs, because the suite is file-parallel.
 *
 * Both are shared mutable state that races when built per file:
 *
 *   `docker build --tag` reassigns the stub tag to a fresh image ID and strips the old one, so
 *   a file that already resolved the previous ID gets `exit 125: No such image`.
 *
 *   Two `tsc` runs writing the same `dist/` can leave a child process importing a half-written
 *   build — observed as a run whose containers were missing changes already in the source.
 */
export default async function setup(): Promise<void> {
  await execa('npm', ['run', 'build']);
  await buildStubAgent();
}
