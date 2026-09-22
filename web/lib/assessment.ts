import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { invoke } from "./harness";
import { readRun, RESULTS_ROOT, StoreError } from "./store";
import { TASK_IDS } from "./domain";

export const gatePolicySchema = z
  .object({
    schema_version: z.literal(1),
    required_tasks: z
      .array(z.enum(TASK_IDS as [string, ...string[]]))
      .max(12)
      .refine((v) => new Set(v).size === v.length)
      .default([]),
    min_pass_rate: z.number().min(0).max(1).default(1),
    require_live: z.boolean().default(true),
    max_regressions: z.number().int().min(0).optional(),
    max_mean_wall_seconds: z.number().nonnegative().optional(),
    max_total_cost_usd: z.number().min(0).optional(),
  })
  .strict();
export const gateRequestSchema = z
  .object({ policy: gatePolicySchema, baseline: z.string().optional() })
  .strict();

const count = z.number().int().nonnegative();
const metricsSchema = z.object({
  planned_trials: count,
  recorded_trials: count,
  eligible_trials: count,
  passed_trials: count,
  pass_rate: z.number().min(0).max(1).nullable(),
  coverage_complete: z.boolean(),
  infra_errors: count,
  cleanup_errors: count,
  destructive_actions: count,
  total_cost_usd: z.number().nonnegative().nullable(),
  known_cost_trials: count,
  mean_wall_seconds: z.number().nonnegative().nullable(),
});
const transitionsSchema = z.object({
  improved: count,
  regressed: count,
  unchanged: count,
  inconclusive: count,
});
const groupSchema = z.object({
  baseline: metricsSchema,
  candidate: metricsSchema,
  transitions: transitionsSchema,
});
const descriptorSchema = z.object({
  folder: z.string(),
  run_id: z.string(),
  model: z.string(),
  mode: z.string(),
  status: z.string(),
});
const comparisonSchema = z.object({
  schema_version: z.literal(1),
  candidate: descriptorSchema,
  baseline: descriptorSchema,
  warnings: z.array(z.string()),
  configuration_differences: z.array(
    z.object({
      field: z.string(),
      baseline: z.unknown(),
      candidate: z.unknown(),
    }),
  ),
  summary: groupSchema,
  tasks: z.array(groupSchema.extend({ task_id: z.string() })),
  slots: z.array(
    z.object({
      task_id: z.string(),
      trial: count,
      baseline: z.enum(["pass", "fail", "inconclusive"]),
      candidate: z.enum(["pass", "fail", "inconclusive"]),
      transition: z.enum([
        "improved",
        "regressed",
        "unchanged",
        "inconclusive",
      ]),
    }),
  ),
});
const gateSchema = z.object({
  schema_version: z.literal(1),
  passed: z.boolean(),
  warnings: z.array(z.string()),
  run: descriptorSchema,
  policy: gatePolicySchema,
  checks: z
    .array(
      z.object({
        name: z.string(),
        passed: z.boolean(),
        actual: z.unknown(),
        expected: z.unknown(),
        message: z.string(),
      }),
    )
    .min(1),
  comparison: comparisonSchema.nullable().optional(),
});

type Dependencies = { run: typeof invoke; read: typeof readRun; root: string };
const defaults: Dependencies = {
  run: invoke,
  read: readRun,
  root: RESULTS_ROOT,
};
async function decode(
  args: string[],
  allowed: number[],
  deps: Dependencies,
  schema: z.ZodType,
) {
  const response = await deps.run(args, 30000, true);
  if (response.timedOut)
    throw new StoreError(
      "Assessment timed out. Saved evidence is unchanged; use the terminal command or retry.",
      503,
    );
  if (!allowed.includes(response.code ?? -1)) {
    // Only the CLI JSON error is exposed; stderr can contain local paths or diagnostics.
    let message = "Assessment could not finish. Inspect the run with the CLI.";
    try {
      const value = JSON.parse(response.stdout);
      if (typeof value.error === "string") message = value.error.slice(0, 2000);
    } catch {}
    throw new StoreError(message, response.code === 2 ? 422 : 503);
  }
  try {
    const parsed = schema.parse(JSON.parse(response.stdout));
    if (
      args[0] === "gate" &&
      (parsed as { passed: boolean }).passed !== (response.code === 0)
    )
      throw new Error("Gate exit code conflicts with verdict");
    return parsed;
  } catch {
    throw new StoreError(
      "Assessment returned unreadable output. Saved evidence remains available.",
      503,
    );
  }
}
export async function compareRuns(
  candidate: string,
  baseline: string,
  deps = defaults,
) {
  await Promise.all([deps.read(candidate), deps.read(baseline)]);
  return decode(
    [
      "compare",
      path.join(deps.root, candidate),
      "--baseline",
      path.join(deps.root, baseline),
      "--json",
    ],
    [0],
    deps,
    comparisonSchema,
  );
}
export async function assessGate(id: string, raw: unknown, deps = defaults) {
  const { policy, baseline } = gateRequestSchema.parse(raw);
  await deps.read(id);
  if (baseline) await deps.read(baseline);
  if (policy.max_regressions !== undefined && !baseline)
    throw new StoreError("Select a baseline when setting a regression limit.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "gauntlet-gate-"));
  try {
    const file = path.join(directory, "policy.json");
    await writeFile(file, JSON.stringify(policy), { mode: 0o600, flag: "wx" });
    const args = ["gate", path.join(deps.root, id), "--policy", file, "--json"];
    if (baseline) args.push("--baseline", path.join(deps.root, baseline));
    return await decode(args, [0, 1], deps, gateSchema);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
