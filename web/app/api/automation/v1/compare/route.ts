import { automationRequest } from "@/lib/automation-auth";
import { compareCloudRuns } from "@/lib/cloud-assessment";
import { failure, json } from "@/lib/http";
export const maxDuration = 300;
export async function GET(request: Request) {
  try {
    await automationRequest(request, "assess");
    const query = new URL(request.url).searchParams;
    return json(
      await compareCloudRuns(
        query.get("candidate") || "",
        query.get("baseline") || "",
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
