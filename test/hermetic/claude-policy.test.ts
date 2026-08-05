import { describe, expect, it } from 'vitest';

import {
  CLAUDE_AUTH_PATH,
  CLAUDE_CODING_PERMISSION_ARGS,
  CLAUDE_CODING_TOOLS,
  CLAUDE_LAUNCHER,
  CLAUDE_PRINT_FLAG,
  buildClaudeSpec,
  compileClaudePolicy,
  hashClaudePolicy,
} from '../../src/adapters/claude/policy.js';
import type { RuntimeImages } from '../../src/docker/images.js';

const PROMPT = 'Implement slugify in src/slugify.js';
const MODEL = 'claude-sonnet-5';
const EFFORT = 'medium';

const IMAGES: RuntimeImages = {
  codex: { role: 'codex', id: `sha256:${'a'.repeat(64)}` },
  claude: { role: 'claude', id: `sha256:${'b'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'c'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'d'.repeat(64)}` },
  reviewer: { role: 'reviewer', id: `sha256:${'9'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'e'.repeat(64)}` },
};

const auth = { type: 'volume', source: 'auth', target: CLAUDE_AUTH_PATH } as const;
const workspace = { type: 'volume', source: 'workspace', target: '/workspace' } as const;
const dependencies = {
  type: 'volume',
  source: 'dependencies',
  target: '/workspace/node_modules',
} as const;

function coding() {
  return compileClaudePolicy({
    mode: 'coding',
    prompt: PROMPT,
    model: MODEL,
    effort: EFFORT,
  });
}

describe('Claude policy compiler', () => {
  it('emits exactly the gated coding invocation', () => {
    expect(coding().args).toEqual([
      CLAUDE_LAUNCHER,
      CLAUDE_PRINT_FLAG,
      PROMPT,
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--safe-mode',
      '--no-chrome',
      '--tools',
      CLAUDE_CODING_TOOLS.join(','),
      ...CLAUDE_CODING_PERMISSION_ARGS,
      '--model',
      MODEL,
      '--effort',
      EFFORT,
    ]);
  });

  it('emits a diagnosis invocation with no tools, workspace, or permission mode', () => {
    const policy = compileClaudePolicy({
      mode: 'diagnosis',
      prompt: 'Diagnose this failure.',
      model: 'claude-opus-5',
      effort: 'high',
    });
    const spec = buildClaudeSpec({
      policy,
      images: IMAGES,
      network: 'egress',
      env: {},
      mounts: [auth],
    });

    expect(policy.args).toEqual([
      CLAUDE_LAUNCHER,
      CLAUDE_PRINT_FLAG,
      'Diagnose this failure.',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--safe-mode',
      '--no-chrome',
      '--tools',
      '',
      '--model',
      'claude-opus-5',
      '--effort',
      'high',
    ]);
    expect(policy.args).not.toContain('--permission-mode');
    expect(spec.workdir).toBe('/home/agent');
    expect(spec.mounts).toEqual([auth]);
    expect(JSON.stringify(spec)).not.toContain('/workspace');
  });

  it('returns the exact coding mount and image contract', () => {
    const spec = buildClaudeSpec({
      policy: coding(),
      images: IMAGES,
      network: 'egress',
      env: { HTTPS_PROXY: 'http://proxy:8080' },
      mounts: [workspace, dependencies, auth],
    });

    expect(spec).toMatchObject({
      image: IMAGES.claude.id,
      workdir: '/workspace',
      network: 'egress',
      mounts: [workspace, dependencies, auth],
      env: { HTTPS_PROXY: 'http://proxy:8080' },
    });
  });

  it('exposes no bare, fallback, resume, plugin, web, browser, or MCP escape', () => {
    const hostile = compileClaudePolicy({
      mode: 'coding',
      prompt: PROMPT,
      model: MODEL,
      effort: EFFORT,
      bare: true,
      fallbackModel: 'latest',
      resume: true,
      plugins: ['host-plugin'],
    } as Parameters<typeof compileClaudePolicy>[0]);
    const serialized = hostile.args.join(' ');

    for (const forbidden of [
      '--bare',
      '--fallback-model',
      '--resume',
      '--plugin-dir',
      '--mcp-config',
      '--chrome',
      '--web',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('hashes files, argv, env, model, effort, and mode deterministically', () => {
    const base = coding();
    expect(coding().hash).toBe(base.hash);

    const changed = (mutate: (policy: typeof base) => void): string => {
      const policy = structuredClone(base);
      mutate(policy);
      return hashClaudePolicy(policy);
    };

    expect([
      changed((policy) => void (policy.files['settings.json'] = '{}')),
      changed((policy) => void policy.args.push('--changed')),
      changed((policy) => void (policy.env.CHANGED = '1')),
      changed((policy) => void (policy.model = 'changed-model')),
      changed((policy) => void (policy.effort = 'high')),
      changed((policy) => void (policy.mode = 'diagnosis')),
    ]).not.toContain(base.hash);
  });
});
