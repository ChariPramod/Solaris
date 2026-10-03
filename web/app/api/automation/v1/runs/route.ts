import { automationRequest } from "@/lib/automation-auth";
import { listCloudRuns } from "@/lib/cloud-artifacts";
import { failure, json } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await automationRequest(request, "read");
    return json(await listCloudRuns());
  } catch (error) {
    return failure(error);
  }
}
