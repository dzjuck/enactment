export const HARNESS_VERSION = '0.1.0';

/**
 * DESIGN.md §7: the provider allowlist and the container contract are version-specific,
 * so the Codex version is a pin like any other.
 */
export const CODEX_VERSION = '0.146.0';

/** Multi-arch index digest, resolved from the registry. One base for all four images. */
export const NODE_BASE_IMAGE =
  'node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46';

/** DESIGN.md §5/§36: fixed numeric identity, so `--user` and tmpfs ownership agree. */
export const AGENT_UID = 1001;
export const AGENT_GID = 1001;

export type ImageRole = 'agent' | 'verifier' | 'setup' | 'proxy';

export const IMAGE_ROLES: readonly ImageRole[] = ['agent', 'verifier', 'setup', 'proxy'];

export interface ImagePin {
  role: ImageRole;
  tag: string;
  /** Build context, relative to the repository root. */
  context: string;
  buildArgs: Record<string, string>;
  /** When set, the built image must resolve to exactly this digest. */
  digest?: string;
}

const COMMON_BUILD_ARGS = {
  BASE_IMAGE: NODE_BASE_IMAGE,
  AGENT_UID: String(AGENT_UID),
  AGENT_GID: String(AGENT_GID),
};

export const IMAGE_PINS: Record<ImageRole, ImagePin> = {
  agent: {
    role: 'agent',
    tag: `ai-harness/agent:${HARNESS_VERSION}`,
    context: 'images/agent',
    buildArgs: { ...COMMON_BUILD_ARGS, CODEX_VERSION },
  },
  verifier: {
    role: 'verifier',
    tag: `ai-harness/verifier:${HARNESS_VERSION}`,
    context: 'images/verifier',
    buildArgs: { ...COMMON_BUILD_ARGS },
  },
  setup: {
    role: 'setup',
    tag: `ai-harness/setup:${HARNESS_VERSION}`,
    context: 'images/setup',
    buildArgs: { ...COMMON_BUILD_ARGS },
  },
  proxy: {
    role: 'proxy',
    tag: `ai-harness/proxy:${HARNESS_VERSION}`,
    context: 'images/proxy',
    buildArgs: { ...COMMON_BUILD_ARGS },
  },
};
