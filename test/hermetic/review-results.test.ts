import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  parseReviewResults,
  ReviewResultsError,
} from '../../src/review/results.js';
import type { ReviewTargets } from '../../src/review/targets.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/review', import.meta.url));

const CRITICAL = `const serialize = require('node-serialize');
module.exports = (payload) => serialize.unserialize(payload);
`;
const WARNING = `module.exports = () => Math.random();
`;

/** Semgrep derives a local check ID from the config directory, so the pack layout is in it. */
const RULES_PREFIX = 'opt.enactment.rules.javascript.gitlab-lgpl';
const CRITICAL_RULE = `${RULES_PREFIX}.eval.rules_lgpl_javascript_eval_rule-node-deserialize`;
const WARNING_RULE = `${RULES_PREFIX}.crypto.rules_lgpl_javascript_crypto_rule-node-insecure-random-generator`;
const SHIFTED_DUPLICATE = `// a new leading comment
${WARNING}${WARNING}`;

function targets(
  before: Record<string, string> = {},
  after: Record<string, string> = {},
): ReviewTargets {
  return {
    before: Object.entries(before).map(([path, content]) => ({
      path,
      content: Buffer.from(content),
    })),
    after: Object.entries(after).map(([path, content]) => ({
      path,
      content: Buffer.from(content),
    })),
  };
}

async function fixture(name: string): Promise<string> {
  return await readFile(`${FIXTURES}/${name}.json`, 'utf8');
}

function rawFinding(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '1.172.0',
    results: [
      {
        check_id: 'rule.id',
        path: '/review/after/src/file.js',
        start: { line: 1, col: 1, offset: 0 },
        end: { line: 1, col: 4, offset: 3 },
        extra: { severity: 'WARNING' },
        ...overrides,
      },
    ],
    errors: [],
    paths: { scanned: ['/review/after/src/file.js'] },
  });
}

function catchResults(document: string, reviewTargets = targets({}, { 'src/file.js': 'abc' })) {
  try {
    parseReviewResults(document, reviewTargets);
  } catch (cause) {
    expect(cause).toBeInstanceOf(ReviewResultsError);
    expect((cause as ReviewResultsError).category).toBe('review_failed');
    return cause as ReviewResultsError;
  }
  throw new Error('expected review results to fail');
}

describe('review result normalization', () => {
  it('normalizes recorded ERROR output without retaining message, matched text, or scanner path', async () => {
    const result = parseReviewResults(
      await fixture('critical'),
      targets({}, { 'src/run.js': CRITICAL }),
    );

    expect(result).toEqual({
      findings: [
        {
          ruleId: CRITICAL_RULE,
          path: 'src/run.js',
          severity: 'critical',
          location: {
            start: { line: 2, column: 31 },
            end: { line: 2, column: 61 },
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /message|serialize\.unserialize|requires login|\/review\/after/,
    );
  });

  it.each([
    ['ERROR', 'critical'],
    ['WARNING', 'warning'],
    ['INFO', 'warning'],
  ] as const)('maps %s to %s', (scannerSeverity, severity) => {
    expect(
      parseReviewResults(
        rawFinding({ extra: { severity: scannerSeverity } }),
        targets({}, { 'src/file.js': 'abc' }),
      ).findings[0]?.severity,
    ).toBe(severity);
  });

  it('fails closed on unknown severity, scanner errors, malformed JSON, and missing fields', async () => {
    expect(catchResults(rawFinding({ extra: { severity: 'NOTICE' } })).message).toContain(
      'severity',
    );
    expect(catchResults(await fixture('scan-error')).message).toContain('errors');
    expect(catchResults('{').message).toContain('JSON');
    expect(catchResults(rawFinding({ check_id: undefined })).message).toContain('result');
  });

  it.each([
    ['/etc/passwd', 'absolute'],
    ['/review/after/../secret.js', 'traversal'],
    ['/review/after/src/missing.js', 'target'],
  ])('rejects %s paths', (path, expectedMessage) => {
    expect(catchResults(rawFinding({ path })).message.toLowerCase()).toContain(expectedMessage);
  });

  it.each([
    { start: { line: 0, col: 1, offset: 0 } },
    { end: { line: 1, col: 1, offset: 10 } },
    { start: { line: 2, col: 1, offset: 2 }, end: { line: 1, col: 2, offset: 1 } },
  ])('rejects an invalid location %#', (location) => {
    expect(catchResults(rawFinding(location)).message).toContain('location');
  });
});

describe('introduced finding subtraction', () => {
  it('ignores a line-only move and keeps one newly introduced identical duplicate', async () => {
    const result = parseReviewResults(
      await fixture('duplicates'),
      targets({ 'src/random.js': WARNING }, { 'src/random.js': SHIFTED_DUPLICATE }),
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ruleId: WARNING_RULE,
      path: 'src/random.js',
      severity: 'warning',
      location: { start: { line: 3, column: 24 } },
    });
  });

  it('reports a new rule, path, or changed exact match and drops removed findings', () => {
    const base = JSON.parse(rawFinding()) as {
      results: Record<string, unknown>[];
      [key: string]: unknown;
    };
    const after = base.results[0];
    if (after === undefined) throw new Error('missing fixture finding');

    const document = JSON.stringify({
      ...base,
      results: [
        { ...after, path: '/review/before/src/file.js' },
        { ...after, check_id: 'new.rule' },
        { ...after, path: '/review/after/src/renamed.js' },
        { ...after, path: '/review/before/src/removed.js' },
        {
          ...after,
          path: '/review/before/src/changed.js',
          end: { line: 1, col: 4, offset: 3 },
        },
        {
          ...after,
          path: '/review/after/src/changed.js',
          end: { line: 1, col: 5, offset: 4 },
        },
      ],
    });

    const result = parseReviewResults(
      document,
      targets(
        { 'src/file.js': 'abc', 'src/removed.js': 'abc', 'src/changed.js': 'abcd' },
        { 'src/file.js': 'abc', 'src/renamed.js': 'abc', 'src/changed.js': 'abce' },
      ),
    );

    expect(result.findings.map(({ ruleId, path }) => [ruleId, path])).toEqual([
      ['rule.id', 'src/changed.js'],
      ['new.rule', 'src/file.js'],
      ['rule.id', 'src/renamed.js'],
    ]);
  });

  it('uses matched-text hashes internally, not source text in ReviewResult', () => {
    const result = parseReviewResults(rawFinding(), targets({}, { 'src/file.js': 'abc' }));
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('abc');
    expect(serialized).not.toContain(createHash('sha256').update('abc').digest('hex'));
  });

  it('sorts stably by severity, path, position, then rule ID', () => {
    const base = JSON.parse(rawFinding()) as { results: Record<string, unknown>[] };
    const finding = base.results[0];
    if (finding === undefined) throw new Error('missing fixture finding');
    const document = JSON.stringify({
      ...base,
      results: [
        { ...finding, check_id: 'z.warning', path: '/review/after/z.js' },
        { ...finding, check_id: 'b.critical', extra: { severity: 'ERROR' } },
        { ...finding, check_id: 'a.critical', extra: { severity: 'ERROR' } },
      ],
      paths: { scanned: ['/review/after/src/file.js', '/review/after/z.js'] },
    });

    const first = parseReviewResults(
      document,
      targets({}, { 'src/file.js': 'abc', 'z.js': 'abc' }),
    );
    const second = parseReviewResults(
      document,
      targets({}, { 'src/file.js': 'abc', 'z.js': 'abc' }),
    );

    expect(first.findings.map((item) => item.ruleId)).toEqual([
      'a.critical',
      'b.critical',
      'z.warning',
    ]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
