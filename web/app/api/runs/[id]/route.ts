import { readRun } from "@/lib/store";
import { failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    localRequest(request);
    return json(await readRun((await context.params).id));
  } catch (e) {
    return failure(e);
  }
}
