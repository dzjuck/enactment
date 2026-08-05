/**
 * The fixed reviewer contract: scanner invocation, mount layout, severity mapping, budget.
 *
 * DESIGN.md §29 and the M5 plan: none of this is task input. It is harness policy, hashed
 * into `policy_hash`, so changing a flag, a root or a severity mapping requires a new
 * approval. The rule *content* is deliberately not here — it lives in the reviewer image, so
 * a rule edit changes `reviewer_image_id` instead, and `activePolicy()` stays pure over
 * source constants rather than reading files.
 */

/** Where the review volume is mounted, read-only, inside the reviewer container. */
export const REVIEW_ROOT = '/review';

/** Copies of the parent's version of every modified file. Added files have no baseline. */
export const REVIEW_BEFORE_ROOT = `${REVIEW_ROOT}/before`;

/** Copies of the candidate's version of every added and modified file. */
export const REVIEW_AFTER_ROOT = `${REVIEW_ROOT}/after`;

/** Vendored rules, baked into the image and read-only at runtime. */
export const REVIEW_RULES_DIR = '/opt/ai-harness/rules';

/**
 * The exact argument array, minus the two roots the caller appends after `--`.
 *
 * Local rules only, structured output, no metrics and no update check: the container has no
 * network, so anything that reached out would hang rather than fail.
 */
export const REVIEW_ARGS: readonly string[] = [
  'semgrep',
  'scan',
  '--config',
  REVIEW_RULES_DIR,
  '--json',
  '--metrics',
  'off',
  '--disable-version-check',
];

export type ReviewSeverity = 'critical' | 'warning';

/**
 * Scanner severity to harness severity. `INFO` is mapped rather than rejected — an unknown
 * severity must fail closed, and an unmapped known one would be indistinguishable from that —
 * but the vendored subset contains no `INFO` rule, so a high-risk step cannot block on style.
 */
export const REVIEW_SEVERITY_MAP: Readonly<Record<string, ReviewSeverity>> = {
  ERROR: 'critical',
  WARNING: 'warning',
  INFO: 'warning',
};

/** One scan over the changed files of one step. Generous, and bounded. */
export const REVIEW_TIMEOUT_SECONDS = 300;
