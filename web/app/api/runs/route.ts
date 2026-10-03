import { cloudEnabled, listCloudRuns } from "@/lib/cloud-artifacts";
import { listRuns } from "@/lib/store";
import { failure, json, localRequest } from "@/lib/http";
import { libraryQuery } from "@/lib/library-query";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const query = libraryQuery(request.url);
    return json(await (cloudEnabled() ? listCloudRuns(query) : listRuns()));
  } catch (e) {
    return failure(e);
  }
}
