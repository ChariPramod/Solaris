import { z } from "zod";
import { cloudEnabled } from "@/lib/cloud-artifacts";
import { cancelCloudJob } from "@/lib/cloud-runner";
import { body, failure, json, localRequest } from "@/lib/http";
import { StoreError } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    localRequest(request, true);
    if (!cloudEnabled())
      throw new StoreError("Cloud execution is not enabled.", 400);
    z.object({})
      .strict()
      .parse(await body(request));
    const { id } = await context.params;
    return json(await cancelCloudJob(id), 202);
  } catch (error) {
    return failure(error);
  }
}
