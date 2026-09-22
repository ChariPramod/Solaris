import { z } from "zod";
import { cloudEnabled, readCloudRun } from "@/lib/cloud-artifacts";
import { cloudOrigin } from "@/lib/cloud-auth";
import { getPublicCloudJob, startCloudRun } from "@/lib/cloud-runner";
import { listKeys } from "@/lib/cloud-storage";
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
    if (!cloudEnabled()) return json({ jobs: [] });
    const listing = await listKeys("jobs/", 200);
    const jobs = [];
    for (let i = 0; i < listing.keys.length; i += 8) {
      jobs.push(
        ...(await Promise.all(
          listing.keys
            .slice(i, i + 8)
            .map((key) => getPublicCloudJob(key.slice(5, -5))),
        )),
      );
    }
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json({ jobs, truncated: listing.truncated });
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
      ),
      202,
    );
  } catch (e) {
    return failure(e);
  }
}
