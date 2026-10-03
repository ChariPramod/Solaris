import { automationRequest } from "@/lib/automation-auth";
import { listCloudRuns } from "@/lib/cloud-artifacts";
import { failure, json } from "@/lib/http";
import { libraryQuery } from "@/lib/library-query";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await automationRequest(request, "read");
    return json(await listCloudRuns(libraryQuery(request.url)));
  } catch (error) {
    return failure(error);
  }
}
