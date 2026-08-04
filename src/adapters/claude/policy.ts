/** Constants proven against Claude Code 2.1.221 by the Milestone 4 feasibility gate. */
export const CLAUDE_AUTH_PATH = '/run/claude-auth';
export const CLAUDE_LAUNCHER = 'claude-from-token';
export const CLAUDE_PRINT_FLAG = '-p';

export const CLAUDE_BASE_ARGS: readonly string[] = [
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--safe-mode',
  '--no-chrome',
];

export const CLAUDE_CODING_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash',
];

/** One permission control only; the outer Docker container is the security boundary. */
export const CLAUDE_CODING_PERMISSION_ARGS: readonly string[] = [
  '--permission-mode',
  'bypassPermissions',
];

/**
 * `--safe-mode` suppresses workspace CLAUDE.md and customizations. The init event still
 * advertises built-in skill/agent metadata, but neither is callable unless its tool is present;
 * coding exposes only CLAUDE_CODING_TOOLS and diagnosis exposes no tools.
 */
export const CLAUDE_DIAGNOSIS_TOOLS = '';
