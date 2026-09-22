export const maxDuration = 300;
import { cloudEnabled } from "@/lib/cloud-artifacts";
import { assessCloudGate } from "@/lib/cloud-assessment";
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
    return json(
      await (cloudEnabled() ? assessCloudGate : assessGate)(
        id,
        await body(request),
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
