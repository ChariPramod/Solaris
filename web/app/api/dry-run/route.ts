import { cloudEnabled } from "@/lib/cloud-artifacts";
import { StoreError } from "@/lib/store";
import { launchDryRun } from "@/lib/harness";
import { body, failure, json, localRequest } from "@/lib/http";
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    if (cloudEnabled())
      throw new StoreError(
        "Use the cloud jobs endpoint to launch an evaluation.",
        400,
      );
    return json(await launchDryRun(await body(request)));
  } catch (e) {
    return failure(e);
  }
}
