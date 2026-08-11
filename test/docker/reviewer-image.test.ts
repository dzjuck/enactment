import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AGENT_GID, AGENT_UID, IMAGE_PINS, SEMGREP_VERSION } from '../../src/config/pins.js';
import { runContainer, type RunResult } from '../../src/docker/run.js';
import {
  REVIEW_AFTER_ROOT,
  REVIEW_ARGS,
  REVIEW_BEFORE_ROOT,
  REVIEW_ROOT,
} from '../../src/review/policy.js';

/**
 * Fixtures deliberately trip *search*-mode rules. Half the vendored set is taint mode with
 * narrow sources — an enclosing function's argument, or browser `location` — so a plausible
 * looking sample can produce an honest zero-finding scan and prove nothing about the image.
 */

/** Trips `spawn-shell-true`, an ERROR rule: `spawn(..., {shell: $SHELL})`. */
const CRITICAL = `const { spawn } = require('child_process');
spawn('ls', ['-la'], { shell: true });
`;

/** Trips `detect-pseudoRandomBytes`, a WARNING rule: `crypto.pseudoRandomBytes`. */
const WARNING = `const crypto = require('crypto');
module.exports = () => crypto.pseudoRandomBytes(16);
`;

const CLEAN = `export function add(a, b) {
  return a + b;
}
`;

const BROKEN = `export function broken( {
`;

interface SemgrepOutput {
  results: {
    check_id: string;
    path: string;
    extra: { severity: string; lines: string };
    start: { line: number; col: number };
    end: { line: number; col: number };
  }[];
  errors: unknown[];
}

let root: string;

/**
 * Step 3 parses recorded output of this exact contract rather than a handwritten
 * approximation, so a scan can save its raw JSON: `ENACTMENT_RECORD_REVIEW=1 npm run test:docker`
 * refreshes `fixtures/review/` from the pinned image.
 */
const FIXTURES = fileURLToPath(new URL('../../fixtures/review', import.meta.url));

/** Scan one prepared `/review` tree with exactly the approved argument array. */
async function scan(
  files: Record<string, string>,
  record?: string,
): Promise<{ run: RunResult; json: SemgrepOutput }> {
  const dir = await mkdtemp(join(root, 'tree-'));

  for (const [path, content] of Object.entries(files)) {
    const absolute = join(dir, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content);
  }

  await mkdir(join(dir, 'before'), { recursive: true });
  await mkdir(join(dir, 'after'), { recursive: true });

  const run = await runContainer(
    {
      image: IMAGE_PINS.reviewer.tag,
      argv: [...REVIEW_ARGS, '--', REVIEW_BEFORE_ROOT, REVIEW_AFTER_ROOT],
      network: 'none',
      mounts: [{ type: 'bind', source: dir, target: REVIEW_ROOT, readonly: true }],
    },
    { timeoutSeconds: 120, graceSeconds: 5 },
  );

  if (record !== undefined && process.env.ENACTMENT_RECORD_REVIEW !== undefined) {
    await mkdir(FIXTURES, { recursive: true });
    await writeFile(join(FIXTURES, `${record}.json`), `${run.stdout}\n`);
  }

  return { run, json: JSON.parse(run.stdout) as SemgrepOutput };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'enactment-reviewer-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('pinned reviewer image', () => {
  it('reports the pinned scanner version', async () => {
    const result = await runContainer(
      {
        image: IMAGE_PINS.reviewer.tag,
        argv: ['semgrep', '--version'],
        network: 'none',
      },
      { timeoutSeconds: 120, graceSeconds: 5 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(SEMGREP_VERSION);
  }, 300_000);

  it('runs as the fixed non-root identity with no network', async () => {
    const result = await runContainer(
      {
        image: IMAGE_PINS.reviewer.tag,
        argv: ['sh', '-c', 'id -u; id -g; touch /probe 2>&1 || echo read-only-root'],
        network: 'none',
      },
      { timeoutSeconds: 120, graceSeconds: 5 },
    );

    expect(result.stdout).toContain(String(AGENT_UID));
    expect(result.stdout).toContain(String(AGENT_GID));
    expect(result.stdout).toContain('read-only-root');
  }, 300_000);

  it('emits valid empty JSON when nothing matches', async () => {
    // Only meaningful beside the ERROR and WARNING fixtures below. They run the same image
    // and the same config, so a rule set that failed to load turns this pass into three
    // failures rather than into a silent clean scan.
    const { run, json } = await scan({ 'after/src/add.js': CLEAN }, 'clean');

    expect(run.exitCode).toBe(0);
    expect(json.results).toEqual([]);
    expect(json.errors).toEqual([]);
  }, 300_000);

  it('reports an ERROR finding with rule ID, path, positions and matched text', async () => {
    const { json } = await scan({ 'after/src/run.js': CRITICAL }, 'critical');

    expect(json.results).toHaveLength(1);
    const [finding] = json.results;
    expect(finding?.extra.severity).toBe('ERROR');
    expect(finding?.check_id).toContain('spawn-shell-true');
    expect(finding?.path).toBe(`${REVIEW_AFTER_ROOT}/src/run.js`);
    expect(finding?.start.line).toBeGreaterThan(0);
    expect(finding?.end.line).toBeGreaterThan(0);
    expect(finding?.extra.lines.length).toBeGreaterThan(0);
  }, 300_000);

  it('reports a WARNING finding', async () => {
    const { json } = await scan({ 'after/src/random.js': WARNING }, 'warning');

    expect(json.results.map((result) => result.extra.severity)).toEqual(['WARNING']);
  }, 300_000);

  it('keeps identical findings separate under both prefixes and after a line shift', async () => {
    const { json } = await scan(
      {
        'before/src/random.js': WARNING,
        'after/src/random.js': `// a new leading comment\n${WARNING}${WARNING}`,
      },
      'duplicates',
    );

    const byRoot = json.results.filter((result) => result.path.startsWith(REVIEW_AFTER_ROOT));
    expect(json.results.length).toBe(3);
    expect(byRoot).toHaveLength(2);
    // The same rule fires identically under a prefix, and duplicates are separate results.
    expect(new Set(byRoot.map((result) => result.extra.lines.trim())).size).toBe(1);
    expect(new Set(byRoot.map((result) => result.start.line)).size).toBe(2);
  }, 300_000);

  it('reports a parse failure as an error rather than as a clean scan', async () => {
    const { json } = await scan({ 'after/src/broken.js': BROKEN }, 'scan-error');

    expect(json.errors.length).toBeGreaterThan(0);
    expect(json.results).toEqual([]);
  }, 300_000);
});
