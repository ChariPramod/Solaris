import { listRuns } from "@/lib/store";
import { failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    localRequest(request);
    return json(await listRuns());
  } catch (e) {
    return failure(e);
  }
}
