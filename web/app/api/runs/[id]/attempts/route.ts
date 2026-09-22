import { cloudEnabled } from "@/lib/cloud-artifacts";
import { getAttempts as getCloudAttempts } from "@/lib/cloud-workspace-data";
import { getAttempts } from "@/lib/workspace-data";
import { failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    localRequest(request);
    return json(
      await (cloudEnabled() ? getCloudAttempts : getAttempts)(
        (await context.params).id,
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
