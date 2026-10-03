import { automationRequest } from "@/lib/automation-auth";
import { getPublicCloudJob } from "@/lib/cloud-runner";
import { failure, json } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await automationRequest(request, "read");
    return json(await getPublicCloudJob((await context.params).id));
  } catch (error) {
    return failure(error);
  }
}
