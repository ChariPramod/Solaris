import { automationRequest } from "@/lib/automation-auth";
import { assessCloudGate } from "@/lib/cloud-assessment";
import { body, failure, json } from "@/lib/http";
export const maxDuration = 300;
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await automationRequest(request, "assess");
    return json(
      await assessCloudGate((await context.params).id, await body(request)),
    );
  } catch (error) {
    return failure(error);
  }
}
