export const HARNESS_VERSION = '0.1.0';

/**
 * DESIGN.md §7: the provider allowlist and the container contract are version-specific,
 * so the Codex version is a pin like any other.
 */
export const CODEX_VERSION = '0.146.0';

/**
 * DESIGN.md §7: exactly this, exact-match, no wildcards. Measured, not guessed —
 * `ab.chatgpt.com` appears but is not required, and denying it costs nothing.
 */
export const PROVIDER_ALLOWLIST: readonly string[] = ['chatgpt.com'];

/**
 * The Codex version domain discovery was actually run against. Kept as its own literal so
 * that bumping CODEX_VERSION without re-running discovery is a test failure rather than a
 * silently stale allowlist.
 */
export const PROVIDER_ALLOWLIST_CODEX_VERSION = '0.146.0';

export const TYPESCRIPT_VERSION = '5.9.3';
export const TYPES_NODE_VERSION = '24.10.1';

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
  /** Dockerfile path, when it is not `<context>/Dockerfile`. */
  dockerfile?: string;
  buildArgs: Record<string, string>;
}

/**
 * Locally built images have no registry digest, and their image ID changes on every build.
 * The pin is therefore a content digest over layers plus config (see `resolveContentDigest`),
 * which is platform-specific. Pins are **required**: an unpinned image is a configuration
 * error, not a permissive default.
 *
 * Refreshing a pin is an explicit source change. Nothing updates this table at runtime.
 */
export const BUILT_IMAGE_PINS: Record<string, Record<ImageRole, string>> = {
  'linux/arm64': {
    agent: 'sha256:9fe344e1bd32870b1b9d5a9271a7827a9a909b7de79a7a4b186d1cd1bcffe6d5',
    verifier: 'sha256:33a2d53e43d9fe1c4e34317dea36f7428c051c2cbeaa60195d11db25bf6c119c',
    setup: 'sha256:038a161bf2739ccc58dae0b1b38a370c9a7ddaa561c1928806036e82ce380dee',
    proxy: 'sha256:a4741dc58bf67ff444d69a574b9c4eeb9de12ff9b0217a9ab7a11605e352cb98',
  },
};

export const SUPPORTED_PLATFORMS: readonly string[] = Object.keys(BUILT_IMAGE_PINS);

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
  // Built from the repository root: the proxy sources are compiled inside the image.
  proxy: {
    role: 'proxy',
    tag: `ai-harness/proxy:${HARNESS_VERSION}`,
    context: '.',
    dockerfile: 'images/proxy/Dockerfile',
    buildArgs: { ...COMMON_BUILD_ARGS, TYPESCRIPT_VERSION, TYPES_NODE_VERSION },
  },
};
