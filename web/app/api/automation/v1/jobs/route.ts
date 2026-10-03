import { createHash } from "node:crypto";
import { z } from "zod";
import { automationRequest } from "@/lib/automation-auth";
import { cloudOrigin } from "@/lib/cloud-auth";
import { readCloudRun } from "@/lib/cloud-artifacts";
import { startCloudRun } from "@/lib/cloud-runner";
import { setupSchema } from "@/lib/harness";
import { body, failure, json } from "@/lib/http";
import { StoreError } from "@/lib/store";
import { listCloudJobs, listReservedCloudJobs } from "@/lib/cloud-job-list";
import { jobQuery } from "@/lib/job-query";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  try {
    await automationRequest(request, "read");
    const query = jobQuery(request.url);
    return json(
      query.view === "reserved"
        ? await listReservedCloudJobs()
        : await listCloudJobs(undefined, query),
    );
  } catch (error) {
    return failure(error);
  }
}
const schema = z
  .object({
    setup: setupSchema,
    mode: z.enum(["dry-run", "live"]),
    parentId: z.string().max(120).optional(),
  })
  .strict();
export async function POST(request: Request) {
  try {
    // Authenticate before reading data or accessing cloud storage outside the token document.
    const token = await automationRequest(request, "execute");
    const input = schema.parse(await body(request));
    if (input.mode === "live") await automationRequest(request, "live:execute");
    const key = request.headers.get("idempotency-key");
    if (!key || !/^[A-Za-z0-9_.:-]{16,128}$/.test(key))
      throw new StoreError(
        "Supply an Idempotency-Key of 16–128 letters, numbers, underscores, dots, colons or hyphens. Reuse it only for retries of this exact request.",
        400,
      );
    if (input.parentId) await readCloudRun(input.parentId);
    return json(
      await startCloudRun(
        input.setup,
        input.mode,
        cloudOrigin(),
        input.parentId,
        createHash("sha256").update(`${token.id}:${key}`).digest("hex"),
      ),
      202,
    );
  } catch (error) {
    return failure(error);
  }
}
