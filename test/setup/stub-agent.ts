import { buildStubAgent } from '../helpers/stub-agent.js';

/**
 * Build the stub agent image once, before any docker-suite file runs.
 *
 * Several files need it, and the suite is file-parallel. Building it per file races on the
 * tag: `docker build --tag` reassigns the tag to a fresh image ID and strips the old one, so
 * a file that already resolved the previous ID starts containers from an image that no longer
 * exists and gets `exit 125: No such image`.
 */
export default async function setup(): Promise<void> {
  await buildStubAgent();
}
