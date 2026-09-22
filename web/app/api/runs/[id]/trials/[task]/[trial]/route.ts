import { readTrial } from "@/lib/store";
import { failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; task: string; trial: string }> },
) {
  try {
    localRequest(request);
    const p = await context.params;
    return json(await readTrial(p.id, p.task, Number(p.trial)));
  } catch (e) {
    return failure(e);
  }
}
