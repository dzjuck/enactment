import type { PlanProgress, PlanReport } from './coordinator.js';

export interface ProgressWriterOptions {
  write: (text: string) => void;
  now: () => number;
}

export interface ProgressWriter {
  event: (event: PlanProgress) => void;
  finish: (report?: PlanReport) => void;
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${String(seconds)}s`;
  return `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s`;
}

function short(commit: string): string {
  return commit.slice(0, 7);
}

export function createProgressWriter(options: ProgressWriterOptions): ProgressWriter {
  const startedAt = options.now();
  let artifactsRoot: string | undefined;
  let openPhase: { name: string; startedAt: number } | undefined;
  let finished = false;

  const closePhase = (endedAt = options.now()): void => {
    if (openPhase === undefined) return;
    options.write(` ${duration(endedAt - openPhase.startedAt)}\n`);
    openPhase = undefined;
  };

  const event = (progress: PlanProgress): void => {
    if (finished) return;

    if (progress.kind === 'plan') {
      artifactsRoot = progress.artifactsRoot;
      options.write(
        `plan     ${progress.planId}\n` +
          `repo     ${progress.repoPath}\n` +
          `base     ${progress.baseBranch} ${short(progress.baseCommit)}\n` +
          `branch   ${progress.branch}\n\n`,
      );
      return;
    }

    if (progress.kind === 'step') {
      closePhase();
      const type = progress.attempt === 'stronger' ? 'retry' : progress.stepType;
      options.write(
        `[${String(progress.index)}/${String(progress.total)}] ${progress.stepId}` +
          `  ${type}  ${progress.provider} ${progress.model}/${progress.effort}\n`,
      );
      return;
    }

    if (progress.kind === 'phase') {
      closePhase();
      openPhase = { name: progress.name, startedAt: options.now() };
      options.write(`      ${progress.name}`);
      return;
    }

    closePhase();
    if (progress.status === 'committed') {
      options.write(
        `      committed${progress.commit === undefined ? '' : ` ${short(progress.commit)}`}\n\n`,
      );
      return;
    }

    options.write(
      `      FAILED ${progress.category ?? 'internal_error'}: ${progress.message ?? 'step failed'}\n`,
    );
    if (progress.evidence !== undefined) {
      options.write(`      evidence ${progress.evidence}\n`);
    }
  };

  const finish = (report?: PlanReport): void => {
    if (finished) return;
    finished = true;
    const endedAt = options.now();
    closePhase(endedAt);

    if (report?.state === 'completed') {
      const commits = report.steps.filter((step) => step.commit !== undefined).length;
      options.write(
        `completed  ${String(report.steps.length)} steps  ${String(commits)} commits` +
          `  ${duration(endedAt - startedAt)}\n`,
      );
      options.write(
        `branch     ${report.branch}${report.head === undefined ? '' : `  ${short(report.head)}`}\n`,
      );
      if (artifactsRoot !== undefined) options.write(`artifacts  ${artifactsRoot}\n`);
      return;
    }

    if (report?.state === 'cancelled') {
      options.write(`cancelled  ${report.failure?.message ?? 'plan was cancelled'}\n`);
      return;
    }

    options.write(`failed     ${report?.failure?.message ?? 'run did not return a report'}\n`);
  };

  return { event, finish };
}
