import { describe, expect, it, vi } from 'vitest';

import type { DemoResult } from '../../demo/run.mjs';

const RESULT = {
  exitCode: 0,
  report: {
    plan: 'task-summary',
    state: 'completed',
    branch: 'enactment/task-summary',
    baseCommit: 'a'.repeat(40),
    steps: [],
    finalVerification: {
      commands: [{ stdout: 'escaped test output must stay in the report' }],
    },
  },
  root: '/tmp/demo',
  repoPath: '/tmp/demo/repo',
  stateDirectory: '/tmp/demo/state',
  artifactDir: '/tmp/demo/artifacts',
  manifestPath: '/tmp/demo/execution-manifest.yml',
  baseCommit: 'a'.repeat(40),
  productionImages: {},
} as unknown as DemoResult;

describe('demo direct entry', () => {
  it('stops before build and execution when live credentials are unavailable', async () => {
    const { runDemoCommand } = await import('../../demo/run.mjs');
    let output = '';
    const build = vi.fn(() => Promise.resolve());
    const main = vi.fn(() => Promise.resolve(RESULT));

    const result = await runDemoCommand({
      mode: 'live',
      write: (text) => {
        output += text;
      },
      checkCredentials: () => Promise.resolve(['codex', 'claude']),
      build,
      main,
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(build).not.toHaveBeenCalled();
    expect(main).not.toHaveBeenCalled();
    expect(output).toBe(
      [
        'LIVE DEMO NOT STARTED',
        '',
        'Missing or invalid provider credentials:',
        '- Codex: run `codex login`',
        '- Claude: run `claude setup-token`, then save the token as documented',
        '',
        'Setup guide: https://github.com/dzjuck/enactment#try-it-live',
        '',
      ].join('\n'),
    );
  });

  it('returns the structured result without serializing its report', async () => {
    const { runDemoMain } = await import('../../demo/run.mjs');
    let output = '';
    const run = vi.fn(async ({ write }: { write: (text: string) => void }) => {
      write('completed  2 steps  2 commits\n');
      write('execution: replay; recorded answers; no provider called\n');
      return RESULT;
    });

    const result = await runDemoMain({
      mode: 'replay',
      write: (text) => {
        output += text;
      },
      run,
    });

    expect(result).toBe(RESULT);
    expect(result.exitCode).toBe(0);
    expect(output).toContain('completed  2 steps  2 commits');
    expect(output).not.toContain('finalVerification');
    expect(output).not.toContain('escaped test output');
    expect(output).not.toContain('{');
    expect(output).not.toContain('}');
  });

  it('formats a rejected setup or prepare call as one concise failure and retained paths', async () => {
    const { runDemoMain } = await import('../../demo/run.mjs');
    let output = '';
    const error = Object.assign(new Error('\u001b[31mdemo prepare failed\u001b[0m\nstack line'), {
      demoPaths: {
        repoPath: '/tmp/demo/repo',
        stateDirectory: '/tmp/demo/state',
        artifactDir: '/tmp/demo/artifacts',
        manifestPath: '/tmp/demo/execution-manifest.yml',
      },
      report: { error: { nested: 'must not print' } },
    });

    const result = await runDemoMain({
      mode: 'replay',
      write: (text) => {
        output += text;
      },
      run: () => Promise.reject(error),
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(output).toBe(
      [
        'demo failed  demo prepare failed',
        'repo         /tmp/demo/repo',
        'state        /tmp/demo/state',
        'artifacts    /tmp/demo/artifacts/task-summary',
        'manifest     /tmp/demo/execution-manifest.yml',
        '',
      ].join('\n'),
    );
    expect(output).not.toContain('stack line');
    expect(output).not.toContain('nested');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('{');
  });

  it('points a live credential failure to the setup guide', async () => {
    const { runDemoMain } = await import('../../demo/run.mjs');
    let output = '';
    const failure = {
      ...RESULT,
      exitCode: 1,
      report: {
        plan: 'task-summary',
        state: 'failed',
        branch: 'enactment/task-summary',
        baseCommit: 'a'.repeat(40),
        steps: [],
        failure: {
          category: 'internal_error',
          message: 'no auth.json in /user/.codex: run `codex login` once, then retry',
        },
      },
    } as unknown as DemoResult;

    const result = await runDemoMain({
      mode: 'live',
      write: (text) => {
        output += text;
      },
      run: () => Promise.resolve(failure),
    });

    expect(result).toBe(failure);
    expect(output).toBe(
      [
        '',
        'credentials: missing or invalid',
        'fix: follow README.md#try-it-live, then run npm run demo again',
        '',
      ].join('\n'),
    );
  });
});
