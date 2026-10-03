import { cloudEnabled } from "@/lib/cloud-artifacts";
import { StoreError } from "@/lib/store";
import { getPublicCloudJob } from "@/lib/cloud-runner";
import { failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    localRequest(request);
    if (!cloudEnabled())
      throw new StoreError("Cloud execution is not enabled.", 400);
    const { id } = await context.params;
    return json(await getPublicCloudJob(id));
  } catch (error) {
    return failure(error);
  }
}
