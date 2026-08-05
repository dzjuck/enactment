import type { RuntimeImage } from '../docker/images.js';

/**
 * The only seam through which the agent invocation may be substituted.
 *
 * It exists for the test suites, which must drive the whole pipeline without spending model
 * tokens. It is deliberately unreachable from production: the CLI has no flag and reads no
 * environment variable that constructs one, so an operator cannot run a different image than
 * the set resolved at startup.
 *
 * The substitution is scoped to the provider invocation — the container the model itself runs
 * in, whichever provider the attempt's profile selected, plus the coordinator's separate
 * diagnosis call. Harness-owned helpers keep the resolved production images even when they
 * happen to use a provider image, because they are the harness acting, not the model. Whatever
 * is substituted still carries a real, resolved identity and is recorded in the run manifest
 * exactly like any other image: injection never suspends the rule that what ran is what was
 * recorded.
 */
export interface RunInjection {
  /** Replaces the image the Codex invocation runs. */
  codex?: RuntimeImage;
  /** Replaces the image the Claude invocation runs. */
  claude?: RuntimeImage;
  /** Merged under the harness's own agent environment, which always wins. */
  agentEnv?: Record<string, string>;
  /** Test-only environment for the separate, workspace-free diagnosis invocation. */
  diagnosisEnv?: Record<string, string>;
  /**
   * Fixes the attempt id. A test that has to inspect a run's Docker resources from outside —
   * after killing it, say — needs to know which label to look for without scanning globally
   * and picking up another test's work.
   */
  attempt?: string;
}
