import { constants } from "node:fs";
import { open, readdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { summarizeRun } from "./domain";
import type { ActionFrame, Library, Run, TrialDetail } from "./types";

export const PROJECT_ROOT = path.resolve(
  process.env.GAUNTLET_PROJECT_ROOT || path.join(process.cwd(), ".."),
);
export const RESULTS_ROOT = path.join(PROJECT_ROOT, "results");
export class StoreError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const number = z.number().finite().nonnegative();
const trialSchema = z.object({
  task_id: z.string().regex(/^T\d{2}$/),
  trial: number.int().min(1),
  tier: number.int(),
  model: z.string(),
  mode: z.string(),
  passed: z.boolean(),
  steps: number.int(),
  wall_seconds: number,
  termination: z.string(),
  failure_class: z.string().nullable(),
  failure_stage: z.string().nullable().optional(),
  cleanup_error: z.string().nullable().default(null),
  error: z.string().nullable().optional(),
  cost_usd: number.nullable(),
  cost_status: z.string().optional(),
  tokens_in: number.int(),
  tokens_out: number.int(),
  evidence: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.string(),
});
const runSchema = z.object({
  schema_version: z.union([z.literal(1), z.literal(2)]).default(1),
  run_id: z.string().optional(),
  created_at: z.string(),
  mode: z.string(),
  model: z.string(),
  status: z.string(),
  planned_trials: number.int().max(10000),
  trials_per_task: number.int().min(1).max(10000),
  task_ids: z.array(z.string().regex(/^T\d{2}$/)).max(100),
  records: z.array(trialSchema).max(10000),
  tasks: z
    .record(
      z.string(),
      z.object({
        definition: z.object({
          id: z.string(),
          name: z.string(),
          tier: number.int(),
          prompt: z.string(),
          max_steps: number,
          max_seconds: number,
        }),
        sha256: z.string().optional(),
      }),
    )
    .default({}),
  configuration: z.record(z.string(), z.unknown()).default({}),
  stop_reason: z
    .object({
      kind: z.string(),
      limit: number,
      observed_failures: number,
      task_id: z.string(),
      trial: number,
    })
    .optional(),
  recovery: z.record(z.string(), z.unknown()).optional(),
});
export function validId(id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id))
    throw new StoreError("Invalid run identifier.");
  return id;
}
export async function safeFile(
  root: string,
  segments: string[],
  limit: number,
): Promise<Buffer> {
  if ((await lstat(root)).isSymbolicLink())
    throw new StoreError("The results root must not be a symlink.");
  const base = await realpath(root);
  let current = base;
  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      /[/\\\0]/.test(segment)
    )
      throw new StoreError("Invalid artifact path.");
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw new StoreError("Linked artifacts are not served.");
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(base + path.sep))
    throw new StoreError("Artifact is outside the results folder.");
  const file = await open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new StoreError(
        "Artifact is unavailable or exceeds the size limit.",
      );
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const next = await file.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (!next.bytesRead) break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > limit || bytesRead !== stat.size)
      throw new StoreError("Artifact changed while reading. Retry.");
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
export async function readRun(id: string, root = RESULTS_ROOT): Promise<Run> {
  validId(id);
  try {
    const raw = JSON.parse(
      (await safeFile(root, [id, "results.json"], 16 * 1024 * 1024)).toString(),
    );
    const run = runSchema.parse(raw);
    if (
      new Set(run.task_ids).size !== run.task_ids.length ||
      run.planned_trials !== run.task_ids.length * run.trials_per_task
    )
      throw new StoreError("Run plan is inconsistent.");
    const slots = new Set<string>();
    for (const r of run.records) {
      const key = `${r.task_id}/${r.trial}`;
      if (
        slots.has(key) ||
        !run.task_ids.includes(r.task_id) ||
        r.trial > run.trials_per_task
      )
        throw new StoreError("Run contains conflicting trial identities.");
      slots.add(key);
    }
    return { ...run, id };
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(
      "Run cannot be read. It may be missing, incomplete, or malformed.",
      404,
    );
  }
}
export async function listRuns(root = RESULTS_ROOT): Promise<Library> {
  const result: Library = {
    runs: [],
    warnings: [],
    source: "local",
    scannedAt: new Date().toISOString(),
  };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw new StoreError("The results folder cannot be read.", 503);
  }
  const candidates = entries
    .filter(
      (e) =>
        e.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(e.name),
    )
    .sort((a, b) => b.name.localeCompare(a.name));
  if (candidates.length > 200)
    result.warnings.push("Only the first 200 run folders were scanned.");
  for (const entry of candidates.slice(0, 200)) {
    try {
      result.runs.push(summarizeRun(await readRun(entry.name, root)));
    } catch {
      result.warnings.push(
        `${entry.name}: unavailable or malformed; other runs remain accessible.`,
      );
    }
  }
  result.runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return result;
}
export function parseActions(text: string) {
  const frames: ActionFrame[] = [];
  const warnings: string[] = [];
  const frameSchema = z.object({
    step: z.number().int().positive().optional(),
    screenshot: z.string().optional(),
    action: z
      .object({ kind: z.string(), params: z.record(z.string(), z.unknown()) })
      .optional(),
    response: z.unknown().optional(),
    action_error: z.string().optional(),
    tokens_in: number.optional(),
    tokens_out: number.optional(),
    cost_usd: number.nullable().optional(),
  });
  const lines = text.split("\n").filter((l) => l.trim());
  for (const [index, line] of lines.slice(0, 1000).entries()) {
    try {
      const value = frameSchema.parse(JSON.parse(line));
      frames.push(value);
    } catch {
      warnings.push(
        `Action line ${index + 1} is incomplete or invalid and was skipped.`,
      );
    }
  }
  if (lines.length > 1000)
    warnings.push("Action history limited to 1,000 lines.");
  return { frames, warnings };
}
export async function readTrial(
  id: string,
  task: string,
  trial: number,
  root = RESULTS_ROOT,
): Promise<TrialDetail> {
  if (!/^T\d{2}$/.test(task) || !Number.isSafeInteger(trial) || trial < 1)
    throw new StoreError("Invalid trial identifier.");
  const run = await readRun(id, root);
  const record = run.records.find(
    (r) => r.task_id === task && r.trial === trial,
  );
  if (!record)
    throw new StoreError("No result was recorded for this trial.", 404);
  let frames: ActionFrame[] = [];
  let warnings: string[] = [];
  try {
    ({ frames, warnings } = parseActions(
      (
        await safeFile(
          root,
          [id, task, String(trial), "actions.jsonl"],
          4 * 1024 * 1024,
        )
      ).toString(),
    ));
  } catch {
    warnings.push(
      "Action history is missing or unreadable. The saved result is still available.",
    );
  }
  const screenshots: string[] = [];
  const names = new Set([
    ...frames
      .map((f) => f.screenshot)
      .filter(
        (s): s is string => typeof s === "string" && /^\d{3,6}\.jpg$/.test(s),
      ),
    "final.jpg",
  ]);
  if (names.size > 100) warnings.push("Screenshot list limited to 100 images.");
  for (const name of [...names].slice(0, 100)) {
    try {
      await safeFile(root, [id, task, String(trial), name], 10 * 1024 * 1024);
      screenshots.push(name);
    } catch {
      /* UI provides an explicit empty image state. */
    }
  }
  return { trial: record, frames, warnings, screenshots };
}
