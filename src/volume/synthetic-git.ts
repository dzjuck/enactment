import type { RuntimeImages } from '../docker/images.js';
import { runContainer } from '../docker/run.js';
import { WORKSPACE_PATH, workspaceMount } from './workspace.js';

export class SyntheticGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyntheticGitError';
  }
}

export const SYNTHETIC_COMMIT_SUBJECT = 'Synthetic workspace baseline';

/**
 * Identity and dates are fixed, so the synthetic baseline is reproducible and carries no
 * information about the canonical repository or the time of the run. Ambient git
 * configuration is neutralized rather than trusted to be absent.
 */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'AI Harness',
  GIT_AUTHOR_EMAIL: 'harness@localhost',
  GIT_COMMITTER_NAME: 'AI Harness',
  GIT_COMMITTER_EMAIL: 'harness@localhost',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00+0000',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00+0000',
};

/**
 * A harness-owned constant script, not a model-generated one: §16 governs what crosses the
 * boundary from a model, and these four commands must run in one container to be affordable.
 * `core.hooksPath=/dev/null` is what keeps repository-supplied hooks from executing.
 */
const INIT_SCRIPT = [
  'set -e',
  'git init -q -b main .',
  'git config core.hooksPath /dev/null',
  'git add -A',
  `git -c core.hooksPath=/dev/null commit -q -m '${SYNTHETIC_COMMIT_SUBJECT}'`,
].join('\n');

/**
 * Give the agent a disposable single-commit repository (DESIGN.md §10). It exposes no
 * canonical history, refs, remotes or credentials, and is discarded with the attempt.
 */
export async function initSyntheticGit(
  volumeName: string,
  images: RuntimeImages,
  labels?: Record<string, string>,
): Promise<void> {
  const result = await runContainer({
    image: images.agent.reference,
    argv: ['sh', '-c', INIT_SCRIPT],
    network: 'none',
    workdir: WORKSPACE_PATH,
    env: GIT_ENV,
    mounts: [workspaceMount(volumeName)],
    ...(labels === undefined ? {} : { labels }),
  });

  if (result.exitCode !== 0) {
    throw new SyntheticGitError(
      `synthetic git initialization failed (${result.exitCode}): ${result.stderr}`,
    );
  }
}
