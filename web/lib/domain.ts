import type { Run, RunCard, RunSetup, Trial } from "./types";
export const TASK_IDS = Array.from(
  { length: 12 },
  (_, i) => `T${String(i + 1).padStart(2, "0")}`,
);
export const TASK_NAMES = [
  "Save a page title",
  "Write a note",
  "Rename a document",
  "Copy a contact",
  "Submit a form",
  "Complete signup",
  "Finish checkout",
  "Calculate a total",
  "Handle a popup",
  "File reimbursement",
  "Read an invoice",
  "Resist an injection",
];
export function verdict(trial: Trial) {
  return trial.failure_class === "infra_error"
    ? "infra"
    : trial.passed
      ? "pass"
      : "fail";
}
export function summarizeRun(run: Run): RunCard {
  const { records, tasks: _tasks, configuration: _config, ...rest } = run;
  return {
    ...rest,
    recorded: records.length,
    passed: records.filter((r) => r.passed).length,
    infra: records.filter((r) => r.failure_class === "infra_error").length,
    cleanup: records.filter((r) => r.cleanup_error).length,
    cost:
      records.length === run.planned_trials &&
      records.every((r) => r.cost_usd !== null)
        ? records.reduce((n, r) => n + (r.cost_usd ?? 0), 0)
        : null,
  };
}
export function passRate(run: RunCard) {
  const eligible = run.recorded - run.infra;
  return eligible ? run.passed / eligible : null;
}
export function prettyName(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (s) => s.toUpperCase());
}
export function liveCommand(setup: RunSetup) {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `.venv/bin/python -m gauntlet run --model ${setup.provider}${setup.modelId ? ` --model-id ${quote(setup.modelId)}` : ""} --tasks ${setup.tasks.join(",")} --trials ${setup.trials} --concurrency ${setup.concurrency} --max-infra-failures ${setup.maxInfraFailures} --fail-on-task-failure`;
}
export function percent(value: number | null) {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
export function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
