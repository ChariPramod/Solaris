import path from "node:path";
import { z } from "zod";
import { readRun, RESULTS_ROOT, StoreError } from "@/lib/store";
import {
  cloudEnabled,
  readCloudRun,
  readCloudArtifact,
} from "@/lib/cloud-artifacts";
import { invoke } from "@/lib/harness";
import { failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
const savedAuditSchema = z
  .object({
    healthy: z.boolean(),
    status: z.string(),
    scope: z.string().optional(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    findings: z
      .array(
        z
          .object({
            severity: z.enum(["info", "warning", "error"]),
            code: z.string(),
            message: z.string(),
          })
          .passthrough(),
      )
      .max(50000),
    cleanup_candidates: z.array(z.unknown()).max(10000),
  })
  .passthrough();
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    localRequest(request);
    const { id } = await context.params;
    if (cloudEnabled()) {
      const run = await readCloudRun(id);
      let saved: unknown;
      try {
        saved = JSON.parse(
          (await readCloudArtifact(id, "audit.json")).toString("utf8"),
        );
      } catch (error) {
        if (error instanceof StoreError) throw error;
        throw new StoreError(
          "Saved audit is unreadable. Original evidence is still available.",
          503,
        );
      }
      const parsed = savedAuditSchema.safeParse(saved);
      if (
        !parsed.success ||
        parsed.data.status !== run.status ||
        parsed.data.counts.planned !== run.planned_trials ||
        parsed.data.counts.recorded !== run.records.length ||
        parsed.data.healthy !==
          !parsed.data.findings.some(
            (f) => f.severity === "warning" || f.severity === "error",
          )
      ) {
        throw new StoreError(
          "Saved audit is invalid or does not match this run. Original evidence is still available.",
          503,
        );
      }
      return json(parsed.data);
    }
    await readRun(id);
    const result = await invoke([
      "audit",
      path.join(RESULTS_ROOT, id),
      "--json",
    ]);
    if (result.timedOut || ![0, 1].includes(result.code ?? -1))
      throw new StoreError(
        "Audit could not finish. Saved results are still available.",
        503,
      );
    return json(JSON.parse(result.stdout));
  } catch (e) {
    return failure(e);
  }
}
