import type { Plan, PlanStep } from '../plan/schema.js';

/**
 * Temporary bridge from a plan to the single-step executor.
 *
 * The executor still runs one step per invocation; the plan coordinator that walks a whole
 * plan arrives in Step 7. Until then a multi-step plan is refused rather than truncated: a
 * harness that silently ran step 1 and reported success would claim the plan was executed.
 */
export function singlePlanStep(plan: Plan): PlanStep {
  const [step] = plan.steps;

  if (step === undefined || plan.steps.length !== 1) {
    throw new Error(
      `plan "${plan.id}" declares ${String(plan.steps.length)} steps; this harness build runs exactly one`,
    );
  }

  return step;
}
