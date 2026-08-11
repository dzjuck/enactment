import { readFile, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  IMAGE_PINS,
  SEMGREP_IMAGE,
  SEMGREP_RULES_COMMIT,
  SEMGREP_RULES_REPOSITORY,
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
const RULE_PACKS_DIR = join(REPO_ROOT, IMAGE_PINS.reviewer.context, 'rule-packs');

/**
 * The vendored selection, verbatim. Enactment owns *which* rules ship; GitLab owns their text.
 * Listing the paths here rather than counting them makes an unreviewed addition — a rule with
 * an unchecked license or an unproven fixture — a test failure rather than a silent grow.
 */
const RULE_PACK_ALLOWLIST: readonly string[] = [
  'javascript/gitlab-lgpl/crypto/rule-node_insecure_random_generator.yml',
  'javascript/gitlab-lgpl/crypto/rule-node_tls_reject.yml',
  'javascript/gitlab-lgpl/database/rule-node_knex_sqli_injection.yml',
  'javascript/gitlab-lgpl/database/rule-node_nosqli_injection.yml',
  'javascript/gitlab-lgpl/database/rule-node_sqli_injection.yml',
  'javascript/gitlab-lgpl/eval/rule-eval_nodejs.yml',
  'javascript/gitlab-lgpl/eval/rule-eval_require.yml',
  'javascript/gitlab-lgpl/eval/rule-node_deserialize.yml',
  'javascript/gitlab-lgpl/eval/rule-serializetojs_deserialize.yml',
  'javascript/gitlab-lgpl/eval/rule-yaml_deserialize.yml',
  'javascript/gitlab-lgpl/exec/rule-shelljs_os_command_exec.yml',
  'javascript/gitlab-lgpl/jwt/rule-hardcoded_jwt_secret.yml',
  'javascript/gitlab-lgpl/jwt/rule-node_jwt_none_algorithm.yml',
  'javascript/gitlab-lgpl/traversal/rule-join_resolve_path_traversal.yml',
  'javascript/gitlab-lgpl/xml/rule-node_xxe.yml',
  'javascript/gitlab-mit/buf/rule-buffer-noassert-read.yml',
  'javascript/gitlab-mit/buf/rule-buffer-noassert-write.yml',
  'javascript/gitlab-mit/dos/rule-non-literal-regexp.yml',
  'javascript/gitlab-mit/eval/rule-eval-with-expression.yml',
  'javascript/gitlab-mit/xss/rule-mustache-escape.yml',
];

/** The upstream rule-test extensions. A fixture sits beside its rule under the same stem. */
const FIXTURE_EXTENSIONS = ['.js', '.ts'];

/**
 * An upstream Semgrep test annotation, `// ruleid: a, b`, which asserts the rule *matches* the
 * next line. `todoruleid:` and `ok:` are not positive, and the lookbehind keeps the first of
 * those from matching here.
 */
const POSITIVE_ANNOTATION = /(?<![\w-])ruleid:[ \t]*([^\n]*)/g;

interface SemgrepRule {
  id: string;
  severity: string;
  languages?: unknown;
  paths?: unknown;
}

/** Semgrep is given the pack root and discovers rules recursively, so the test does too. */
async function ruleFiles(): Promise<string[]> {
  const entries = await readdir(RULE_PACKS_DIR, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
    .map((entry) => entry.split(sep).join('/'))
    .sort();
}

async function rules(): Promise<SemgrepRule[]> {
  const parsed = await Promise.all(
    (await ruleFiles()).map(async (file) => {
      const document = parse(await readFile(join(RULE_PACKS_DIR, file), 'utf8')) as {
        rules: SemgrepRule[];
      };
      return document.rules;
    }),
  );

  return parsed.flat();
}

/** Every rule ID a fixture beside `file` claims the pack detects. */
async function annotatedRuleIds(file: string): Promise<string[]> {
  const stem = join(RULE_PACKS_DIR, file).replace(/\.ya?ml$/, '');
  const sources = await Promise.all(
    FIXTURE_EXTENSIONS.map((extension) => readFile(stem + extension, 'utf8').catch(() => '')),
  );

  return sources
    .flatMap((source) => [...source.matchAll(POSITIVE_ANNOTATION)])
    .flatMap((match) => (match[1] ?? '').split(','))
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

describe('vendored reviewer rule packs', () => {
  it('ships exactly the allowlisted rule files, and one rule per file', async () => {
    expect(await ruleFiles()).toEqual([...RULE_PACK_ALLOWLIST]);
    expect((await rules()).length).toBe(RULE_PACK_ALLOWLIST.length);
  });

  it('gives every rule a unique ID, which is what a finding is reported by', async () => {
    const ids = (await rules()).map((rule) => rule.id);

    for (const id of ids) expect(id).toMatch(/^[\w.-]+$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('proves every rule against an upstream fixture that claims a positive match', async () => {
    for (const file of await ruleFiles()) {
      const document = parse(await readFile(join(RULE_PACKS_DIR, file), 'utf8')) as {
        rules: SemgrepRule[];
      };
      const annotated = await annotatedRuleIds(file);

      for (const rule of document.rules) {
        expect({ rule: rule.id, proven: annotated.includes(rule.id) }).toEqual({
          rule: rule.id,
          proven: true,
        });
      }
    }
  });

  it('declares a language for every rule, so none is silently never applied', async () => {
    for (const rule of await rules()) {
      expect([rule.id, rule.languages]).toEqual([rule.id, expect.arrayContaining([expect.any(String)])]);
    }
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

  it('records the upstream repository and the exact commit the pack was taken from', async () => {
    const provenance = await readFile(join(RULE_PACKS_DIR, 'PROVENANCE.md'), 'utf8');

    expect(provenance).toContain(SEMGREP_RULES_REPOSITORY);
    expect(provenance).toContain(SEMGREP_RULES_COMMIT);
  });

  it('ships the full text of every license the pack is redistributed under', async () => {
    const notices = [
      'LICENSES/GitLab-MIT.txt',
      'LICENSES/LGPL-3.0.txt',
      'LICENSES/GPL-3.0.txt',
      'THIRD_PARTY_NOTICES.md',
    ];

    for (const notice of notices) {
      const text = await readFile(join(RULE_PACKS_DIR, notice), 'utf8');
      expect({ notice, empty: text.trim().length === 0 }).toEqual({ notice, empty: false });
    }
  });
});

describe('reviewer image build contract', () => {
  it('copies the vendored packs to the fixed rules directory and clears the entrypoint', async () => {
    const dockerfile = await readFile(
      join(REPO_ROOT, IMAGE_PINS.reviewer.context, 'Dockerfile'),
      'utf8',
    );

    expect(dockerfile).toContain(`COPY rule-packs ${REVIEW_RULES_DIR}`);
    expect(dockerfile).toContain('ENTRYPOINT []');
    // No credential, no registry login, no rule download at build time.
    expect(dockerfile).not.toMatch(/TOKEN|SEMGREP_APP|login|--config=p\//i);
  });

  it('leaves no non-redistributable rule bundle in the build context', async () => {
    const context = await readdir(join(REPO_ROOT, IMAGE_PINS.reviewer.context));

    expect(context.sort()).toEqual(['Dockerfile', 'rule-packs']);
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
