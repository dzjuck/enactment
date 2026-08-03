import { execa } from 'execa';

import { removeNetwork } from '../net/manage.js';
import { ATTEMPT_LABEL } from '../volume/naming.js';
import type { RunReport } from './orchestrator.js';

export class CleanupError extends Error {
  readonly errors: string[];

  constructor(errors: readonly string[]) {
    super(`attempt cleanup failed: ${errors.join('; ')}`);
    this.name = 'CleanupError';
    this.errors = [...errors];
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Release every registered resource, in reverse acquisition order, collecting failures rather
 * than stopping at the first one.
 *
 * Stopping early would strand everything acquired before the failing step — the resources most
 * likely to still be holding something else open.
 */
export async function releaseAll(
  steps: readonly (() => Promise<void>)[],
): Promise<string[]> {
  const errors: string[] = [];

  for (const release of [...steps].reverse()) {
    try {
      await release();
    } catch (error) {
      errors.push(describeError(error));
    }
  }

  return errors;
}

/**
 * Docker resource kinds, in the only order a sweep can succeed in: a container holds an
 * endpoint on its network and a reference to its volumes, so it has to go first.
 */
const SWEEP_ORDER = ['container', 'volume', 'network'] as const;

type ResourceKind = (typeof SWEEP_ORDER)[number];

export interface SweepDependencies {
  list?: (kind: ResourceKind, attempt: string) => Promise<string[]>;
  removeContainer?: (id: string) => Promise<void>;
  removeVolume?: (id: string) => Promise<void>;
  removeNetwork?: (id: string) => Promise<void>;
}

/** The same sweep, with no attempt to scope it: everything the harness labelled. */
export interface HarnessSweepDependencies {
  list?: (kind: ResourceKind) => Promise<string[]>;
  removeContainer?: (id: string) => Promise<void>;
  removeVolume?: (id: string) => Promise<void>;
  removeNetwork?: (id: string) => Promise<void>;
}

/** A label filter with no value matches every value: every attempt, including unknown ones. */
async function listByFilter(kind: ResourceKind, filter: string): Promise<string[]> {
  const args =
    kind === 'container'
      ? ['ps', '-aq', '--filter', filter]
      : [kind, 'ls', '-q', '--filter', filter];

  const { stdout } = await execa('docker', args);
  return stdout.split('\n').filter((line) => line !== '');
}

function listLabelled(kind: ResourceKind, attempt: string): Promise<string[]> {
  return listByFilter(kind, `label=${ATTEMPT_LABEL}=${attempt}`);
}

function listHarnessLabelled(kind: ResourceKind): Promise<string[]> {
  return listByFilter(kind, `label=${ATTEMPT_LABEL}`);
}

async function removeContainerById(id: string): Promise<void> {
  await execa('docker', ['rm', '--force', id]);
}

async function removeVolumeById(id: string): Promise<void> {
  await execa('docker', ['volume', 'rm', '--force', id]);
}

/**
 * Remove everything still carrying an attempt's label, then prove nothing is left.
 *
 * This is a backstop, not the primary cleanup path: modules own and release their own
 * resources. It exists for the gaps ownership cannot cover — a partially acquired resource
 * whose owner never got to register it, and a teardown cut short by an interrupt.
 *
 * The final emptiness check is the point. A sweep that removed what it could see and stayed
 * silent about the rest would be indistinguishable from a clean attempt.
 */
export async function sweepAttempt(
  attempt: string,
  dependencies: SweepDependencies = {},
): Promise<void> {
  const list = dependencies.list ?? listLabelled;

  await sweep((kind) => list(kind, attempt), dependencies);
}

/**
 * Remove every resource carrying the harness label, whatever attempt it belonged to.
 *
 * This is the restart path: a process killed outright leaves labelled resources whose attempt
 * id nobody remembers, so the only handle on them is the label itself. Because its blast
 * radius is every harness resource on the daemon, it belongs at production CLI startup and
 * nowhere else — `runStep` stays attempt-scoped, which is what lets suites run in parallel.
 * The consequence, and the V1 trade: two production CLI runs at once are unsupported.
 */
export async function sweepHarness(dependencies: HarnessSweepDependencies = {}): Promise<void> {
  const list = dependencies.list ?? listHarnessLabelled;

  await sweep(list, dependencies);
}

interface RemovalDependencies {
  removeContainer?: (id: string) => Promise<void>;
  removeVolume?: (id: string) => Promise<void>;
  removeNetwork?: (id: string) => Promise<void>;
}

async function sweep(
  list: (kind: ResourceKind) => Promise<string[]>,
  dependencies: RemovalDependencies,
): Promise<void> {
  const remove: Record<ResourceKind, (id: string) => Promise<void>> = {
    container: dependencies.removeContainer ?? removeContainerById,
    volume: dependencies.removeVolume ?? removeVolumeById,
    network: dependencies.removeNetwork ?? removeNetwork,
  };

  const attempted: string[] = [];

  for (const kind of SWEEP_ORDER) {
    for (const id of await list(kind)) {
      try {
        await remove[kind](id);
      } catch (error) {
        attempted.push(`${kind} ${id}: ${describeError(error)}`);
      }
    }
  }

  // The final state is what counts, not every step that got there. A removal that raced with
  // one already in flight — "removal is already in progress" — leaves nothing behind and is
  // not a leak. A resource that is still listed is, and then the removal error explains why.
  const errors: string[] = [];

  for (const kind of SWEEP_ORDER) {
    const survivors = await list(kind);
    if (survivors.length > 0) {
      errors.push(`${kind}s still present after cleanup: ${survivors.join(', ')}`);
    }
  }

  if (errors.length > 0) throw new CleanupError([...attempted, ...errors]);
}

/**
 * Fold cleanup failures into the run report.
 *
 * A leaked resource is never reported as a successful run, and it never displaces the reason
 * the run actually failed: the primary phase failure keeps its phase, category and message,
 * and the cleanup errors are recorded beside it.
 */
export function withCleanupOutcome(report: RunReport, errors: readonly string[]): RunReport {
  if (errors.length === 0) return report;

  const cleanupErrors = [...errors];

  return {
    ...report,
    status: 'failed',
    category: report.category ?? 'internal_error',
    message: report.message ?? `cleanup failed: ${cleanupErrors.join('; ')}`,
    cleanupErrors,
  };
}
