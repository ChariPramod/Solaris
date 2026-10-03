import { z } from "zod";
import { summarizeRun } from "./domain";
import { parseRun } from "./store";
import type { RunCard } from "./types";

const count = z.number().int().nonnegative().max(10000);
const finite = z.number().finite().nonnegative();
const text = z.string().max(2000);
const cardSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/),
    schema_version: z.union([z.literal(1), z.literal(2)]).optional(),
    run_id: text.optional(),
    created_at: text,
    mode: text,
    model: text,
    status: text,
    planned_trials: count,
    trials_per_task: count.min(1),
    task_ids: z.array(z.string().regex(/^T\d{2}$/)).max(100),
    recorded: count,
    passed: count,
    infra: count,
    cleanup: count,
    cost: finite.nullable(),
    stop_reason: z
      .object({
        kind: text,
        limit: finite,
        observed_failures: finite,
        task_id: text,
        trial: finite,
      })
      .strict()
      .optional(),
    recovery: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (card) =>
      new Set(card.task_ids).size === card.task_ids.length &&
      card.planned_trials === card.task_ids.length * card.trials_per_task &&
      card.recorded <= card.planned_trials &&
      card.passed <= card.recorded &&
      card.infra <= card.recorded &&
      card.cleanup <= card.recorded &&
      (card.cost === null || card.recorded === card.planned_trials),
  );

const summarySchema = z
  .object({
    version: z.literal(1),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    run: cardSchema,
  })
  .strict();
export type CloudRunSummary = z.infer<typeof summarySchema>;

/** Derived metadata is optional: invalid or old caches must never hide evidence. */
export function readCloudRunSummary(
  id: string,
  manifestSha256: string,
  value: unknown,
): RunCard | null {
  const parsed = summarySchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.manifestSha256 !== manifestSha256 ||
    parsed.data.run.id !== id
  )
    return null;
  return parsed.data.run;
}

/** Only the ingestion path creates this projection, alongside the manifest pointer. */
export function buildCloudRunSummary(
  id: string,
  manifestSha256: string,
  bytes: Buffer,
): CloudRunSummary | undefined {
  try {
    const summary = summarySchema.safeParse({
      version: 1,
      manifestSha256,
      run: summarizeRun(parseRun(id, JSON.parse(bytes.toString("utf8")))),
    });
    return summary.success ? summary.data : undefined;
  } catch {
    // Preserve malformed uploads for diagnosis; detailed readers report the error.
    return undefined;
  }
}
