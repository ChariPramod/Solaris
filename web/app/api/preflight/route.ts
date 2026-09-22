export const maxDuration = 300;
import { cloudEnabled } from "@/lib/cloud-artifacts";
import { checkCloudReadiness } from "@/lib/cloud-readiness";
import { checkReadiness } from "@/lib/harness";
import { body, failure, json, localRequest } from "@/lib/http";
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    return json(
      await (cloudEnabled() ? checkCloudReadiness : checkReadiness)(
        await body(request),
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
