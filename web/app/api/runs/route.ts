import { cloudEnabled, listCloudRuns } from "@/lib/cloud-artifacts";
import { listRuns } from "@/lib/store";
import { failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    localRequest(request);
    return json(await (cloudEnabled() ? listCloudRuns() : listRuns()));
  } catch (e) {
    return failure(e);
  }
}
