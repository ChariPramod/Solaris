"use client";
import { useState } from "react";
import { GitCompareArrows, ShieldCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/client";
import type { Run, RunCard } from "@/lib/types";

type Metrics = {
  planned_trials: number;
  recorded_trials: number;
  eligible_trials: number;
  passed_trials: number;
  pass_rate: number | null;
  coverage_complete: boolean;
  infra_errors: number;
  cleanup_errors: number;
  total_cost_usd: number | null;
  mean_wall_seconds: number | null;
};
type Transitions = {
  improved: number;
  regressed: number;
  unchanged: number;
  inconclusive: number;
};
type Comparison = {
  warnings: string[];
  configuration_differences: {
    field: string;
    baseline: unknown;
    candidate: unknown;
  }[];
  summary: { baseline: Metrics; candidate: Metrics; transitions: Transitions };
  tasks: {
    task_id: string;
    baseline: Metrics;
    candidate: Metrics;
    transitions: Transitions;
  }[];
  slots: {
    task_id: string;
    trial: number;
    baseline: string;
    candidate: string;
    transition: string;
  }[];
};
type Gate = {
  passed: boolean;
  warnings: string[];
  checks: {
    name: string;
    passed: boolean;
    actual: unknown;
    expected: unknown;
    message: string;
  }[];
};
const display = (v: unknown) =>
  v === null || v === undefined
    ? "Unknown"
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v);
const metricLabels: Partial<Record<keyof Metrics, string>> = {
  pass_rate: "Pass rate",
  total_cost_usd: "Estimated model API cost ($)",
  mean_wall_seconds: "Mean time (seconds)",
};
function metricValue(key: keyof Metrics, value: unknown) {
  if (value === null || value === undefined) return "Unknown";
  if (typeof value !== "number") return display(value);
  if (key === "pass_rate") return `${(value * 100).toFixed(1)}%`;
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: key === "total_cost_usd" ? 6 : 3,
  }).format(value);
}
export function RunAssessment({ run, runs }: { run: Run; runs: RunCard[] }) {
  const [baseline, setBaseline] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [minimum, setMinimum] = useState("100");
  const [cost, setCost] = useState("");
  const [wall, setWall] = useState("");
  const [regressions, setRegressions] = useState("0");
  const [live, setLive] = useState(true);
  const [required, setRequired] = useState<string[]>([]);
  const invalidate = () => {
    setGate(null);
    setError("");
  };
  return (
    <section className="space-y-5 py-4">
      <div className="notice">
        <GitCompareArrows size={18} />
        <p>
          Compare independent experiments with matching tasks, fixtures,
          verifiers, environment template and trial counts. Recovered copies of
          the same experiment cannot serve as a baseline.
        </p>
      </div>
      <label className="block space-y-2 text-sm">
        Baseline experiment
        <select
          className="w-full rounded-lg border bg-background p-3"
          value={baseline}
          disabled={busy}
          onChange={(e) => {
            setBaseline(e.target.value);
            setComparison(null);
            invalidate();
          }}
        >
          <option value="">Choose a baseline</option>
          {runs
            .filter((r) => r.id !== run.id)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.id} · {r.mode} · {r.model}
              </option>
            ))}
        </select>
      </label>
      <Button
        variant="outline"
        disabled={busy || !baseline}
        onClick={async () => {
          setBusy(true);
          setError("");
          setComparison(null);
          try {
            setComparison(
              await api<Comparison>(
                `/api/compare?candidate=${encodeURIComponent(run.id)}&baseline=${encodeURIComponent(baseline)}`,
              ),
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <GitCompareArrows size={16} /> Compare with this run
      </Button>
      {comparison && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Object.entries(comparison.summary.transitions).map(
              ([key, value]) => (
                <div className="rounded-xl border p-4" key={key}>
                  <p className="text-xs uppercase text-muted-foreground">
                    {key}
                  </p>
                  <strong className="text-2xl">{value}</strong>
                </div>
              ),
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Costs estimate model API charges only and exclude desktop fees.
            Changes describe paired outcomes, not statistical significance.
            Infrastructure errors, cleanup failures and missing trials are
            inconclusive.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="p-2">Metric</th>
                  <th className="p-2">Baseline</th>
                  <th className="p-2">This run</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    "recorded_trials",
                    "planned_trials",
                    "eligible_trials",
                    "passed_trials",
                    "pass_rate",
                    "total_cost_usd",
                    "mean_wall_seconds",
                    "infra_errors",
                    "cleanup_errors",
                  ] as const
                ).map((k) => (
                  <tr className="border-t" key={k}>
                    <td className="p-2">
                      {metricLabels[k] || k.replaceAll("_", " ")}
                    </td>
                    <td className="p-2">
                      {metricValue(k, comparison.summary.baseline[k])}
                    </td>
                    <td className="p-2">
                      {metricValue(k, comparison.summary.candidate[k])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary className="cursor-pointer text-sm">
              Per-trial changes
            </summary>
            <div className="mt-3 space-y-1">
              {comparison.slots.map((s) => (
                <div
                  key={`${s.task_id}/${s.trial}`}
                  className="grid grid-cols-3 gap-2 border-b py-2 text-xs"
                >
                  <span>
                    {s.task_id} / {s.trial}
                  </span>
                  <span>
                    {s.baseline} → {s.candidate}
                  </span>
                  <strong>{s.transition}</strong>
                </div>
              ))}
            </div>
          </details>
          {comparison.configuration_differences.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm">
                Configuration differences
              </summary>
              <pre className="code-block">
                {JSON.stringify(comparison.configuration_differences, null, 2)}
              </pre>
            </details>
          )}
          {[...new Set(comparison.warnings)].map((v, i) => (
            <p className="notice" key={i}>
              {v}
            </p>
          ))}
        </div>
      )}
      <div className="border-t pt-5">
        <h3 className="mb-2 flex items-center gap-2 font-semibold">
          <ShieldCheck size={18} /> Regression gate
        </h3>
        <p className="mb-4 text-sm text-muted-foreground">
          Full coverage, clean infrastructure, successful cleanup and no
          destructive actions are mandatory. Unknown cost fails a configured
          cost limit.
        </p>
        <fieldset disabled={busy} className="space-y-4" onChange={invalidate}>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-2 text-sm">
              Minimum pass rate (%)
              <Input
                type="number"
                min="0"
                max="100"
                value={minimum}
                onChange={(e) => setMinimum(e.target.value)}
              />
            </label>
            <label className="space-y-2 text-sm">
              Maximum total API cost ($)
              <Input
                type="number"
                min="0"
                step="any"
                placeholder="No limit"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            </label>
            <label className="space-y-2 text-sm">
              Maximum mean time (seconds)
              <Input
                type="number"
                min="0"
                step="any"
                placeholder="No limit"
                value={wall}
                onChange={(e) => setWall(e.target.value)}
              />
            </label>
            <label className="space-y-2 text-sm">
              Maximum regressions
              <Input
                type="number"
                min="0"
                step="1"
                disabled={!baseline}
                value={regressions}
                onChange={(e) => setRegressions(e.target.value)}
              />
            </label>
          </div>
          <div className="space-y-2">
            <p className="text-sm">
              Critical workflows (every trial must pass)
            </p>
            <div className="flex flex-wrap gap-3">
              {run.task_ids.map((task) => (
                <label key={task} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={required.includes(task)}
                    onChange={(e) =>
                      setRequired((v) =>
                        e.target.checked
                          ? [...v, task]
                          : v.filter((t) => t !== task),
                      )
                    }
                  />
                  {task}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => setLive(e.target.checked)}
            />{" "}
            Require live evidence
          </label>
        </fieldset>
        {!live && (
          <p className="my-3 text-sm text-amber-600">
            Diagnostic policy: passing this gate with dry-run evidence is not a
            live benchmark result.
          </p>
        )}
        <Button
          className="mt-4"
          disabled={busy || minimum.trim() === ""}
          onClick={async () => {
            setBusy(true);
            setError("");
            setGate(null);
            try {
              const policy = {
                schema_version: 1,
                require_live: live,
                min_pass_rate: Number(minimum) / 100,
                required_tasks: required,
                ...(cost !== "" ? { max_total_cost_usd: Number(cost) } : {}),
                ...(wall !== "" ? { max_mean_wall_seconds: Number(wall) } : {}),
                ...(baseline && regressions !== ""
                  ? { max_regressions: Number(regressions) }
                  : {}),
              };
              setGate(
                await api<Gate>(
                  `/api/runs/${encodeURIComponent(run.id)}/gate`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      policy,
                      ...(baseline ? { baseline } : {}),
                    }),
                  },
                ),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <ShieldCheck size={16} />
          )}{" "}
          Evaluate saved evidence
        </Button>
      </div>
      {error && (
        <p role="alert" className="notice text-destructive">
          {error}
        </p>
      )}
      {gate && (
        <div className="space-y-3" aria-live="polite">
          <h4 className="font-semibold">
            {gate.passed ? "Gate passed" : "Gate failed"}
            {!live ? " · diagnostic policy" : ""}
          </h4>
          {gate.checks.map((c, i) => (
            <div key={i} className="rounded-lg border p-3 text-sm">
              <strong
                className={c.passed ? "text-emerald-600" : "text-destructive"}
              >
                {c.passed ? "PASS" : "FAIL"} · {c.name.replaceAll("_", " ")}
              </strong>
              <p className="mt-1">{c.message}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Actual: {display(c.actual)} · Expected: {display(c.expected)}
              </p>
            </div>
          ))}
          {gate.warnings.map((v, i) => (
            <p className="notice" key={i}>
              {v}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
