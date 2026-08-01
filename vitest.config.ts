import { defineConfig } from 'vitest/config';

// Three suites, kept separate:
//   hermetic - Node + git only          (npm test)
//   docker   - needs a Docker daemon    (npm run test:docker)
//   live     - real Codex auth, spends tokens, opt-in only (npm run test:live)
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'hermetic',
          include: ['test/hermetic/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'docker',
          include: ['test/docker/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
      {
        test: {
          name: 'live',
          include: ['test/live/**/*.test.ts'],
          testTimeout: 1_800_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
