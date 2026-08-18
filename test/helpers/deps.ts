import { fileURLToPath } from 'node:url';

/**
 * One dependency cache for the whole Docker suite.
 *
 * Every fixture repository pins the same lockfile and the cache is content-addressed, so a
 * private directory per test bought nothing but a repeated container install of the same
 * dependencies — the largest single cost in the suite, paid once per test run. Shared, the
 * suite installs once and keeps the snapshot between runs.
 *
 * `dependency-setup.test.ts` keeps its own directory: it asserts the miss and then the hit,
 * which only holds for a cache nobody else has touched.
 *
 * Two callers pass a fixed key of their own rather than the lockfile-derived one, so their
 * snapshots do not self-invalidate. Delete this directory after changing a fixture's
 * `package-lock.json`.
 */
export const DEPENDENCY_CACHE = fileURLToPath(new URL('../.cache/deps', import.meta.url));
