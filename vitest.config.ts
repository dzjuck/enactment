import { defineConfig } from 'vitest/config';

// Suites are kept separate:
//   hermetic      - Node + git only                 (npm test)
//   docker        - needs a Docker daemon           (npm run test:docker)
//   docker-images - builds the runtime images       (npm run test:docker, first, opt-in)
//   live          - real Codex auth, spends tokens  (npm run test:live, opt-in)
//
// Vitest runs projects concurrently, so the two opt-in suites are absent from the default set
// rather than merely filtered out of it:
//
//   `live` makes real model calls, and a bare `vitest run` must not be able to spend tokens.
//   `docker-images` rebuilds the runtime image tags. A rebuild produces a new image ID and
//   strips the old one, which invalidates the digest references every other file resolved at
//   startup — so it can never share a run with a suite that starts containers.
const IMAGE_BUILDERS = ['test/docker/images.test.ts', 'test/docker/built-image-pins.test.ts'];

const hermetic = {
  test: {
    name: 'hermetic',
    include: ['test/hermetic/**/*.test.ts'],
  },
};

// File-parallel: every test scopes its Docker resources to its own attempt id, so files do
// not observe each other's containers, volumes or networks.
const docker = {
  test: {
    name: 'docker',
    include: ['test/docker/**/*.test.ts'],
    exclude: IMAGE_BUILDERS,
    // Shared images are built once here, never per file: see test/setup/stub-agent.ts.
    globalSetup: ['test/setup/stub-agent.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
};

const dockerImages = {
  test: {
    name: 'docker-images',
    include: IMAGE_BUILDERS,
    // Also passed on the command line: these files rebuild the shared image tags, and two of
    // them in flight at once makes `docker image inspect` fail while a tag is reassigned.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
};

const live = {
  test: {
    name: 'live',
    include: ['test/live/**/*.test.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 300_000,
  },
};

const projects = [hermetic, docker];

if (process.env.HARNESS_IMAGES !== undefined) projects.push(dockerImages);
if (process.env.HARNESS_LIVE !== undefined) projects.push(live);

export default defineConfig({ test: { projects } });
