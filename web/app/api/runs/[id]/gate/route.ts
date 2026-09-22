import { assessGate } from "@/lib/assessment";
import { body, failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    localRequest(request, true);
    const { id } = await context.params;
    return json(await assessGate(id, await body(request)));
  } catch (e) {
    return failure(e);
  }
}
