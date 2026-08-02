import type { StoredArtifact } from '../artifacts/store.js';
import type { RuntimeImage } from '../docker/images.js';

/**
 * The only seam through which the agent invocation may be substituted.
 *
 * It exists for the test suites, which must drive the whole pipeline without spending model
 * tokens. It is deliberately unreachable from production: the CLI has no flag and reads no
 * environment variable that constructs one, so an operator cannot run a different image than
 * the set resolved at startup.
 *
 * The substitution is scoped to the agent invocation — the container the model itself runs
 * in. Harness-owned helpers keep the resolved production images even when they happen to use
 * the agent role, because they are the harness acting, not the model. Whatever is substituted
 * still carries a real, resolved identity and is recorded in the run manifest exactly like
 * any other image: injection never suspends the rule that what ran is what was recorded.
 */
export interface RunInjection {
  /** Replaces the image the agent invocation runs. */
  agent?: RuntimeImage;
  /** Merged under the harness's own agent environment, which always wins. */
  agentEnv?: Record<string, string>;
  /** Substitutes workspace restoration, so its failure path is reachable from a test. */
  restoreWorkspace?: (volume: string, snapshot: StoredArtifact) => Promise<void>;
  /**
   * Fixes the attempt id. A test that has to inspect a run's Docker resources from outside —
   * after killing it, say — needs to know which label to look for without scanning globally
   * and picking up another test's work.
   */
  attempt?: string;
}
