export const ENACTMENT_VERSION = '0.1.0';

/**
 * DESIGN.md §7: the provider allowlist and the container contract are version-specific,
 * so the Codex version is a pin like any other.
 */
export const CODEX_VERSION = '0.146.0';

/** Measured by the Milestone 4 Linux ARM64 feasibility gate. */
export const CLAUDE_VERSION = '2.1.221';

/**
 * DESIGN.md §7: exact-match, no wildcards. Codex uses chatgpt.com for model traffic and
 * auth.openai.com to refresh a ChatGPT login. `ab.chatgpt.com` is not required.
 */
export const CODEX_PROVIDER_ALLOWLIST: readonly string[] = ['chatgpt.com', 'auth.openai.com'];

/**
 * The Codex version domain discovery was actually run against. Kept as its own literal so
 * that bumping CODEX_VERSION without re-running discovery is a test failure rather than a
 * silently stale allowlist.
 */
export const PROVIDER_ALLOWLIST_CODEX_VERSION = '0.146.0';

/** Claude Code 2.1.221 completes coding and diagnosis with this host alone. */
export const CLAUDE_PROVIDER_ALLOWLIST: readonly string[] = ['api.anthropic.com'];

/** Prevents a CLI bump from silently keeping stale domain-discovery evidence. */
export const PROVIDER_ALLOWLIST_CLAUDE_VERSION = '2.1.221';

export const TYPESCRIPT_VERSION = '5.9.3';
export const TYPES_NODE_VERSION = '24.10.1';

/** Multi-arch index digest, resolved from the registry. One base for all five images. */
export const NODE_BASE_IMAGE =
  'node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46';

/**
 * DESIGN.md §29: the V1 reviewer is a pinned offline static scanner. Semgrep Community
 * Edition, by immutable index digest — a floating tag would change what a manifest approved.
 */
export const SEMGREP_VERSION = '1.172.0';
export const SEMGREP_IMAGE =
  'semgrep/semgrep:1.172.0@sha256:65dcd4408adda7c183a6b4550cb1e9b19f7f627a6fbb7e0559bd466bedc44d7b';

/**
 * Provenance of the vendored rule packs. The rule *content* lives in the reviewer image, so a
 * rule edit changes `reviewer_image_id` and re-approval is already required; these constants
 * exist so the vendored copy can be traced back to an exact upstream tree.
 *
 * The selection is an explicit multi-path allowlist, not one subtree, so it is not a constant:
 * `images/reviewer/rule-packs/PROVENANCE.md` owns it and the reviewer contract test asserts it.
 */
export const SEMGREP_RULES_REPOSITORY =
  'https://gitlab.com/gitlab-org/security-products/sast-rules';
export const SEMGREP_RULES_COMMIT = 'd580dedc604363a7606bc0a7192f4edf3e675cae';

/** DESIGN.md §5/§36: fixed numeric identity, so `--user` and tmpfs ownership agree. */
export const AGENT_UID = 1001;
export const AGENT_GID = 1001;

export type ImageRole = 'codex' | 'claude' | 'verifier' | 'reviewer' | 'setup' | 'proxy';

export const IMAGE_ROLES: readonly ImageRole[] = [
  'codex',
  'claude',
  'verifier',
  'reviewer',
  'setup',
  'proxy',
];

/**
 * How one runtime image is built. The tag is a build alias only: what a run executes is the
 * image ID the tag resolves to at startup (see `resolveRuntimeImages`). What is pinned here
 * is the *inputs* — base image, tool versions, agent identity — not the built artifact.
 */
export interface ImagePin {
  role: ImageRole;
  tag: string;
  /** Build context, relative to the repository root. */
  context: string;
  /** Dockerfile path, when it is not `<context>/Dockerfile`. */
  dockerfile?: string;
  buildArgs: Record<string, string>;
}

const COMMON_BUILD_ARGS = {
  BASE_IMAGE: NODE_BASE_IMAGE,
  AGENT_UID: String(AGENT_UID),
  AGENT_GID: String(AGENT_GID),
};

export const IMAGE_PINS: Record<ImageRole, ImagePin> = {
  codex: {
    role: 'codex',
    tag: `enactment/codex:${ENACTMENT_VERSION}`,
    context: 'images/codex',
    buildArgs: { ...COMMON_BUILD_ARGS, CODEX_VERSION },
  },
  claude: {
    role: 'claude',
    tag: `enactment/claude:${ENACTMENT_VERSION}`,
    context: 'images/claude',
    buildArgs: { ...COMMON_BUILD_ARGS, CLAUDE_VERSION },
  },
  verifier: {
    role: 'verifier',
    tag: `enactment/verifier:${ENACTMENT_VERSION}`,
    context: 'images/verifier',
    buildArgs: { ...COMMON_BUILD_ARGS },
  },
  // The only role that is not a Node image: the scanner and its vendored rules, nothing else.
  reviewer: {
    role: 'reviewer',
    tag: `enactment/reviewer:${ENACTMENT_VERSION}`,
    context: 'images/reviewer',
    buildArgs: {
      SEMGREP_IMAGE,
      AGENT_UID: String(AGENT_UID),
      AGENT_GID: String(AGENT_GID),
    },
  },
  setup: {
    role: 'setup',
    tag: `enactment/setup:${ENACTMENT_VERSION}`,
    context: 'images/setup',
    buildArgs: { ...COMMON_BUILD_ARGS },
  },
  // Built from the repository root: the proxy sources are compiled inside the image.
  proxy: {
    role: 'proxy',
    tag: `enactment/proxy:${ENACTMENT_VERSION}`,
    context: '.',
    dockerfile: 'images/proxy/Dockerfile',
    buildArgs: { ...COMMON_BUILD_ARGS, TYPESCRIPT_VERSION, TYPES_NODE_VERSION },
  },
};
