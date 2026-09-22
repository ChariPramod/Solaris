import { compareRuns } from "@/lib/assessment";
import { failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const q = new URL(request.url).searchParams;
    return json(
      await compareRuns(q.get("candidate") || "", q.get("baseline") || ""),
    );
  } catch (e) {
    return failure(e);
  }
}
