import type { RunCard } from "./types";

export type EvidenceMode = "live" | "dry-run";
export type InsightFilter = { mode: EvidenceMode; model?: string };

/** Validate the relationships used by charts; never repair bad evidence into a score. */
export function hasConsistentCounts(run: RunCard): boolean {
  const counts = [
    run.planned_trials,
    run.recorded,
    run.passed,
    run.infra,
    run.cleanup,
  ];
  return (
    counts.every((n) => Number.isSafeInteger(n) && n >= 0) &&
    run.recorded <= run.planned_trials &&
    run.passed + run.infra <= run.recorded &&
    run.cleanup <= run.recorded
  );
}

export function runOutcomes(run: RunCard) {
  if (!hasConsistentCounts(run)) return null;
  return {
    passed: run.passed,
    failed: run.recorded - run.passed - run.infra,
    infrastructure: run.infra,
    unrecorded: run.planned_trials - run.recorded,
  };
}

function timestamp(run: RunCard) {
  const value = Date.parse(run.created_at);
  return Number.isFinite(value) ? value : -Infinity;
}

/** Summary of the supplied library only. Modes never mix, missing cost never becomes zero. */
export function calculateInsights(runs: RunCard[], filter: InsightFilter) {
  const seen = new Set<string>();
  const unique = runs.filter((run) => {
    if (seen.has(run.id)) return false;
    seen.add(run.id);
    return true;
  });
  const modeRuns = unique.filter((run) => run.mode === filter.mode);
  const selected = modeRuns.filter(
    (run) => !filter.model || run.model === filter.model,
  );
  const valid = selected.filter(hasConsistentCounts);
  const total = valid.reduce(
    (sum, run) => {
      const outcome = runOutcomes(run)!;
      sum.planned += run.planned_trials;
      sum.recorded += run.recorded;
      sum.passed += outcome.passed;
      sum.failed += outcome.failed;
      sum.infrastructure += outcome.infrastructure;
      sum.unrecorded += outcome.unrecorded;
      sum.cleanup += run.cleanup;
      sum.complete += Number(
        run.status === "complete" &&
          run.recorded === run.planned_trials &&
          run.planned_trials > 0,
      );
      // Even a numeric cost is unsafe to call complete when planned evidence is missing.
      if (
        run.recorded === run.planned_trials &&
        run.planned_trials > 0 &&
        run.cost !== null &&
        Number.isFinite(run.cost) &&
        run.cost >= 0
      ) {
        sum.knownCost += run.cost;
        sum.knownCostRuns += 1;
      }
      return sum;
    },
    {
      planned: 0,
      recorded: 0,
      passed: 0,
      failed: 0,
      infrastructure: 0,
      unrecorded: 0,
      cleanup: 0,
      complete: 0,
      knownCost: 0,
      knownCostRuns: 0,
    },
  );
  return {
    ...total,
    runCount: valid.length,
    excluded: selected.length - valid.length,
    unknownModeRuns: unique.filter(
      (run) => !["live", "dry-run"].includes(run.mode),
    ).length,
    models: [...new Set(modeRuns.map((run) => run.model))].sort(),
    coveredTasks: [...new Set(valid.flatMap((run) => run.task_ids))].sort(),
    coverage: total.planned ? total.recorded / total.planned : null,
    plannedPassRate: total.planned ? total.passed / total.planned : null,
    cost: total.knownCostRuns ? total.knownCost : null,
    unknownCostRuns: valid.length - total.knownCostRuns,
    recent: [...valid]
      .sort((a, b) => timestamp(b) - timestamp(a) || a.id.localeCompare(b.id))
      .slice(0, 12),
  };
}
