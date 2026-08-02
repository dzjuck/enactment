import { sweepHarness } from './cleanup.js';
import { runTask, type RunOptions, type RunReport } from './orchestrator.js';

export interface ProductionDependencies {
  sweep?: () => Promise<void>;
  run?: (options: RunOptions) => Promise<RunReport>;
}

/**
 * The production entry point: clean up after a previous process, then run the task.
 *
 * A V1 harness killed outright — SIGKILL, a closed laptop, a crashed process — leaves labelled
 * containers, volumes and networks behind, and the attempt id that owned them dies with the
 * process. Startup is the one moment where removing all of them is unambiguous, because no
 * other run of this harness is supposed to exist: V1 does not support two production runs at
 * once, and this is where that assumption is cashed in.
 *
 * The cleanup runs before the task, not after: leftovers a run trips over are worth more as a
 * clean start than as a diagnostic. If it cannot reach an empty state the run never starts —
 * a harness that cannot clean up is not in a state where its next attempt means anything.
 */
export async function runProduction(
  options: RunOptions,
  dependencies: ProductionDependencies = {},
): Promise<RunReport> {
  const sweep = dependencies.sweep ?? sweepHarness;
  const run = dependencies.run ?? runTask;

  await sweep();

  return await run(options);
}
