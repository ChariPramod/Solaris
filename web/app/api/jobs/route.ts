import { z } from "zod";
import { cloudEnabled, readCloudRun } from "@/lib/cloud-artifacts";
import { cloudOrigin } from "@/lib/cloud-auth";
import { startCloudRun } from "@/lib/cloud-runner";
import { listCloudJobs, listReservedCloudJobs } from "@/lib/cloud-job-list";
import { jobQuery } from "@/lib/job-query";
import { setupSchema } from "@/lib/harness";
import { body, failure, json, localRequest } from "@/lib/http";
import { StoreError } from "@/lib/store";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const inputSchema = z
  .object({
    setup: setupSchema,
    mode: z.enum(["dry-run", "live"]),
    parentId: z.string().max(120).optional(),
  })
  .strict();
export async function GET(request: Request) {
  try {
    localRequest(request);
    const query = jobQuery(request.url);
    if (!cloudEnabled())
      return json({
        jobs: [],
        warnings: [],
        truncated: false,
        ...(query.view === "reserved"
          ? { reservations: { known: true, count: 0 } }
          : { page: { nextCursor: null, limit: query.limit, scanned: 0 } }),
      });
    return json(
      query.view === "reserved"
        ? await listReservedCloudJobs()
        : await listCloudJobs(undefined, query),
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    if (!cloudEnabled())
      throw new StoreError("Cloud execution is not enabled.", 400);
    const input = inputSchema.parse(await body(request));
    if (input.parentId) await readCloudRun(input.parentId);
    return json(
      await startCloudRun(
        input.setup,
        input.mode,
        cloudOrigin(),
        input.parentId,
        request.headers.get("idempotency-key") ?? undefined,
      ),
      202,
    );
  } catch (e) {
    return failure(e);
  }
}
