import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CleanupError, sweepHarness } from '../../src/run/cleanup.js';
import type { RunOptions, RunReport } from '../../src/run/orchestrator.js';
import { runProduction } from '../../src/run/production.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

type Kind = 'container' | 'volume' | 'network';

/** A fake daemon: resources by kind, removal recorded in the order it was attempted. */
function daemon(initial: Record<Kind, string[]>, sticky: string[] = []) {
  const state: Record<Kind, string[]> = {
    container: [...initial.container],
    volume: [...initial.volume],
    network: [...initial.network],
  };
  const removed: string[] = [];

  const remove = (kind: Kind) => (id: string) => {
    removed.push(`${kind} ${id}`);
    // A sticky resource reports removal success and then stays: exactly what a container
    // still holding a network endpoint looks like from the outside.
    if (!sticky.includes(id)) state[kind] = state[kind].filter((entry) => entry !== id);
    return Promise.resolve();
  };

  return {
    removed,
    state,
    dependencies: {
      list: (kind: Kind) => Promise.resolve([...state[kind]]),
      removeContainer: remove('container'),
      removeVolume: remove('volume'),
      removeNetwork: remove('network'),
    },
  };
}

describe('sweepHarness', () => {
  it('removes every harness-labelled resource, containers first', async () => {
    const fake = daemon({
      container: ['c1', 'c2'],
      volume: ['v1'],
      network: ['n1'],
    });

    await sweepHarness(fake.dependencies);

    // A container holds an endpoint on its network and a reference to its volumes, so the
    // order is not cosmetic: any other one fails on resources that are still in use.
    expect(fake.removed).toEqual([
      'container c1',
      'container c2',
      'volume v1',
      'network n1',
    ]);
    expect(fake.state).toEqual({ container: [], volume: [], network: [] });
  });

  it('is a no-op when nothing carries the harness label', async () => {
    const fake = daemon({ container: [], volume: [], network: [] });

    await expect(sweepHarness(fake.dependencies)).resolves.toBeUndefined();
    expect(fake.removed).toEqual([]);
  });

  it('fails on a survivor, naming its kind and identifier', async () => {
    const fake = daemon({ container: [], volume: ['v-stuck'], network: [] }, ['v-stuck']);

    const error = await sweepHarness(fake.dependencies).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CleanupError);
    expect((error as CleanupError).errors.join('; ')).toContain('volume');
    expect((error as CleanupError).errors.join('; ')).toContain('v-stuck');
  });

  it('reports a removal that threw, and still checks the final state', async () => {
    const fake = daemon({ container: ['c-stuck'], volume: [], network: [] });

    const error = await sweepHarness({
      ...fake.dependencies,
      removeContainer: () => Promise.reject(new Error('device or resource busy')),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CleanupError);
    const message = (error as CleanupError).errors.join('; ');
    expect(message).toContain('c-stuck');
    expect(message).toContain('device or resource busy');
  });
});

describe('production startup', () => {
  const OPTIONS = { taskFile: 'task.yml', repoPath: '/repo', artifactDir: '/out' } satisfies
    RunOptions;
  const REPORT: RunReport = { status: 'succeeded', attempt: 'a1' };

  it('cleans stale resources before the run starts', async () => {
    const order: string[] = [];

    const report = await runProduction(OPTIONS, {
      sweep: async () => void order.push('sweep'),
      run: async (options: RunOptions) => {
        order.push('run');
        expect(options).toBe(OPTIONS);
        return REPORT;
      },
    });

    expect(order).toEqual(['sweep', 'run']);
    expect(report).toBe(REPORT);
  });

  it('never starts a run when the stale-resource cleanup failed', async () => {
    let started = false;

    await expect(
      runProduction(OPTIONS, {
        sweep: () => Promise.reject(new CleanupError(['volume v-stuck still present'])),
        run: async () => {
          started = true;
          return REPORT;
        },
      }),
    ).rejects.toBeInstanceOf(CleanupError);

    expect(started).toBe(false);
  });

  it('is reached only through the CLI, never from runTask', async () => {
    const orchestrator = await readFile(join(SRC, 'run/orchestrator.ts'), 'utf8');
    const cli = await readFile(join(SRC, 'cli.ts'), 'utf8');

    // Docker suites drive `runTask` directly and in parallel; a global sweep in there would
    // delete another test file's containers mid-run.
    expect(orchestrator).not.toContain('sweepHarness');
    expect(orchestrator).toContain('sweepAttempt');

    expect(cli).toContain('runProduction');
    expect(cli).not.toContain('runTask');
  });
});
