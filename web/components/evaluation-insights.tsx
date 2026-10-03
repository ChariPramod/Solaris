"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, BarChart3, CircleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import {
  calculateInsights,
  runOutcomes,
  type EvidenceMode,
} from "@/lib/evaluation-insights";
import { dateLabel, percent } from "@/lib/domain";
import type { RunCard } from "@/lib/types";

function money(value: number | null) {
  return value === null
    ? "Unknown"
    : value.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      });
}

const segments = [
  { key: "passed", label: "Passed", color: "bg-primary" },
  { key: "failed", label: "Task failed", color: "bg-rose-400" },
  { key: "infrastructure", label: "Infrastructure", color: "bg-amber-300" },
  { key: "unrecorded", label: "Unrecorded", color: "bg-muted-foreground/25" },
] as const;

export function EvaluationInsights({
  runs,
  onOpen,
  loading = false,
}: {
  runs: RunCard[];
  onOpen: (id: string) => void;
  loading?: boolean;
}) {
  const [chosenMode, setChosenMode] = useState<EvidenceMode | null>(null);
  const mode =
    chosenMode ||
    (runs.some((run) => run.mode === "live") ? "live" : "dry-run");
  const [model, setModel] = useState("");
  const insights = useMemo(
    () => calculateInsights(runs, { mode, model }),
    [runs, mode, model],
  );
  if (loading)
    return (
      <section
        aria-label="Evaluation insights"
        aria-busy="true"
        className="space-y-4"
      >
        <p role="status" className="text-sm text-muted-foreground">
          Loading saved evaluation evidence…
        </p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </section>
    );
  return (
    <section aria-label="Evaluation insights" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <p className="eyebrow">MEASURE BEFORE HANDOFF</p>
          <h2 className="mt-2 text-xl font-semibold">
            What your evidence supports.
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Inspect coverage, failures, and known model costs before delivering
            an automation. Summaries reflect the loaded library, not an all-time
            billing ledger.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span className="block">Evidence mode</span>
            <select
              className="max-w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
              value={mode}
              onChange={(e) => {
                setChosenMode(e.target.value as EvidenceMode);
                setModel("");
              }}
            >
              <option value="live">Live agents</option>
              <option value="dry-run">Diagnostics</option>
            </select>
          </label>
          <label className="min-w-0 space-y-1 text-xs text-muted-foreground">
            <span className="block">Model</span>
            <select
              className="max-w-64 rounded-md border bg-background px-3 py-2 text-sm text-foreground"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">All models</option>
              {insights.models.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {mode === "dry-run" && (
        <p className="rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-sm text-amber-200">
          Diagnostic results validate the evaluation workflow. They do not
          measure AI performance or support client reliability claims.
        </p>
      )}
      {(insights.excluded > 0 || insights.unknownModeRuns > 0) && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border p-3 text-sm text-muted-foreground"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {insights.excluded} selected runs have inconsistent counts and are
          excluded. {insights.unknownModeRuns} runs with an unknown evidence
          mode are excluded from both modes.
        </p>
      )}
      {!insights.runCount ? (
        <div className="rounded-xl border border-dashed px-6 py-12 text-center">
          <BarChart3
            className="mx-auto size-8 text-muted-foreground"
            aria-hidden="true"
          />
          <h3 className="mt-3 font-semibold">
            No {mode === "live" ? "live agent" : "diagnostic"} evidence in this
            selection
          </h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Run an evaluation or change the filters. Scores and costs appear
            only when backed by saved evidence.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                label: "Passing planned trials",
                value: percent(insights.plannedPassRate),
                detail: `${insights.passed} passed / ${insights.planned} planned. Missing trials remain in the denominator.`,
              },
              {
                label: "Evidence coverage",
                value: percent(insights.coverage),
                detail: `${insights.recorded} recorded · ${insights.unrecorded} unrecorded across ${insights.runCount} runs.`,
              },
              {
                label: "Operational issues",
                value: `${insights.infrastructure} / ${insights.cleanup}`,
                detail:
                  "Infrastructure failures / cleanup errors. These counts can overlap.",
              },
              {
                label: "Known model cost",
                value: money(insights.cost),
                detail: `${insights.knownCostRuns} of ${insights.runCount} runs have complete cost data. ${insights.unknownCostRuns} unknown; excludes desktop and hosting charges.`,
              },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border bg-card p-5">
                <p className="text-xs text-muted-foreground">{item.label}</p>
                <p className="mono mt-3 text-3xl font-semibold tracking-tight">
                  {item.value}
                </p>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  {item.detail}
                </p>
              </div>
            ))}
          </div>
          <div className="rounded-xl border bg-card">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b p-5">
              <div>
                <h3 className="font-semibold">Recent evidence</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Up to 12 runs, newest first. Task sets may differ; use Compare
                  for a compatibility-checked comparison.
                </p>
              </div>
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                {segments.map((part) => (
                  <span key={part.key} className="flex items-center gap-1.5">
                    <span
                      className={`size-2 rounded-full ${part.color}`}
                      aria-hidden="true"
                    />
                    {part.label}
                  </span>
                ))}
              </div>
            </div>
            <ul className="divide-y">
              {insights.recent.map((run) => {
                const outcome = runOutcomes(run)!;
                const description = `${outcome.passed} passed, ${outcome.failed} task failures, ${outcome.infrastructure} infrastructure failures, ${outcome.unrecorded} unrecorded out of ${run.planned_trials} planned trials`;
                return (
                  <li
                    key={run.id}
                    className="grid min-w-0 gap-3 p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] md:items-center"
                  >
                    <div className="min-w-0">
                      <p
                        className="truncate text-sm font-medium"
                        title={run.model}
                      >
                        {run.model}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {dateLabel(run.created_at)} · {run.status}
                      </p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {run.task_ids.join(", ")}
                      </p>
                    </div>
                    <div>
                      <div
                        className="flex h-3 overflow-hidden rounded-full bg-muted"
                        role="img"
                        aria-label={description}
                      >
                        {segments.map(
                          (part) =>
                            outcome[part.key] > 0 && (
                              <span
                                key={part.key}
                                className={part.color}
                                style={{
                                  width: `${(100 * outcome[part.key]) / run.planned_trials}%`,
                                }}
                              />
                            ),
                        )}
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {outcome.passed}/{run.planned_trials} passed ·{" "}
                        {outcome.unrecorded} unrecorded · {run.cleanup} cleanup
                        errors
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="justify-self-start md:justify-self-end"
                      aria-label={`Inspect evaluation ${run.id}`}
                      onClick={() => onOpen(run.id)}
                    >
                      Inspect <ArrowUpRight aria-hidden="true" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {insights.complete} runs have complete recorded coverage and a
            complete harness status. This summary does not audit artifact
            integrity or certify release readiness; inspect the run and apply
            its quality gate.
          </p>
        </>
      )}
    </section>
  );
}
