import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  IMAGE_PINS,
  SEMGREP_IMAGE,
  SEMGREP_RULES_COMMIT,
  SEMGREP_RULES_PATH,
  SEMGREP_VERSION,
} from '../../src/config/pins.js';
import {
  activePolicy,
  policyHash,
  type ReviewContract,
} from '../../src/plan/execution-manifest.js';
import {
  REVIEW_AFTER_ROOT,
  REVIEW_ARGS,
  REVIEW_BEFORE_ROOT,
  REVIEW_RULES_DIR,
  REVIEW_SEVERITY_MAP,
  REVIEW_TIMEOUT_SECONDS,
} from '../../src/review/policy.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RULES_DIR = join(REPO_ROOT, IMAGE_PINS.reviewer.context, 'rules');

interface SemgrepRule {
  id: string;
  severity: string;
  paths?: unknown;
}

async function ruleFiles(): Promise<string[]> {
  const entries = await readdir(RULES_DIR);
  return entries.filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'));
}

async function rules(): Promise<SemgrepRule[]> {
  const files = await ruleFiles();
  const parsed = await Promise.all(
    files.map(async (file) => {
      const document = parse(await readFile(join(RULES_DIR, file), 'utf8')) as {
        rules: SemgrepRule[];
      };
      return document.rules;
    }),
  );

  return parsed.flat();
}

describe('vendored reviewer rules', () => {
  it('ships a non-empty rule set in the reviewer build context', async () => {
    expect((await ruleFiles()).length).toBeGreaterThan(0);
    expect((await rules()).length).toBeGreaterThan(0);
  });

  it('records upstream provenance and the license the rules are used under', async () => {
    const provenance = await readFile(join(RULES_DIR, 'PROVENANCE.md'), 'utf8');

    expect(provenance).toContain(SEMGREP_RULES_COMMIT);
    expect(provenance).toContain(SEMGREP_RULES_PATH);
    expect((await readFile(join(RULES_DIR, 'LICENSE'), 'utf8')).length).toBeGreaterThan(0);
  });

  it('declares no paths: filter, which a prefixed scan target would defeat', async () => {
    for (const rule of await rules()) {
      expect({ id: rule.id, paths: rule.paths }).toEqual({ id: rule.id, paths: undefined });
    }
  });

  it('contains no INFO rule, so a high-risk step cannot block on a style finding', async () => {
    for (const rule of await rules()) {
      expect([rule.id, rule.severity]).toEqual([rule.id, expect.stringMatching(/^(ERROR|WARNING)$/)]);
    }
  });

  it('gives every rule an ID the harness can report', async () => {
    for (const rule of await rules()) expect(rule.id).toMatch(/^[\w.-]+$/);
  });
});

describe('reviewer image build contract', () => {
  it('copies the vendored rules to the fixed rules directory and clears the entrypoint', async () => {
    const dockerfile = await readFile(
      join(REPO_ROOT, IMAGE_PINS.reviewer.context, 'Dockerfile'),
      'utf8',
    );

    expect(dockerfile).toContain(`COPY rules ${REVIEW_RULES_DIR}`);
    expect(dockerfile).toContain('ENTRYPOINT []');
    // No credential, no registry login, no rule download at build time.
    expect(dockerfile).not.toMatch(/TOKEN|SEMGREP_APP|login|--config=p\//i);
  });
});

describe('approved review policy', () => {
  it('records the pinned scanner, argv, timeout and severity mapping', () => {
    expect(activePolicy().review).toEqual({
      scanner: 'semgrep',
      version: SEMGREP_VERSION,
      image: SEMGREP_IMAGE,
      args: [...REVIEW_ARGS],
      roots: { before: REVIEW_BEFORE_ROOT, after: REVIEW_AFTER_ROOT },
      severity_map: { ...REVIEW_SEVERITY_MAP },
      timeout_seconds: REVIEW_TIMEOUT_SECONDS,
      network: 'none',
    });
  });

  it('compiles an offline local-rules invocation with no shell string or registry config', () => {
    expect(REVIEW_ARGS).toEqual([
      'semgrep',
      'scan',
      '--config',
      REVIEW_RULES_DIR,
      '--json',
      '--metrics',
      'off',
      '--disable-version-check',
    ]);

    const argv = REVIEW_ARGS.join(' ');
    expect(argv).not.toMatch(/p\/|--pro|--autofix|--baseline-commit|--config=auto/);
  });

  it('maps ERROR to critical and both lower severities to warning', () => {
    expect(REVIEW_SEVERITY_MAP).toEqual({
      ERROR: 'critical',
      WARNING: 'warning',
      INFO: 'warning',
    });
  });

  it('carries no rule content digest, so the policy stays pure over source constants', () => {
    const serialized = JSON.stringify(activePolicy().review);

    expect(serialized).not.toContain(SEMGREP_RULES_COMMIT);
    expect(policyHash(activePolicy())).toBe(policyHash(activePolicy()));
  });

  it.each<[string, Partial<ReviewContract>]>([
    ['version', { version: '0.0.0' }],
    ['args', { args: ['semgrep', 'scan'] }],
    ['timeout', { timeout_seconds: 1 }],
    ['severity mapping', { severity_map: { ERROR: 'warning', WARNING: 'warning', INFO: 'warning' } }],
  ])('changes the policy hash when the reviewer %s changes', (_label, override) => {
    const policy = activePolicy();
    const changed = { ...policy, review: { ...policy.review, ...override } };

    expect(policyHash(changed)).not.toBe(policyHash(policy));
  });
});
