import { cloudEnabled } from "@/lib/cloud-artifacts";
import {
  getReview as getCloudReview,
  saveReview as saveCloudReview,
} from "@/lib/cloud-workspace-data";
import { getReview, saveReview } from "@/lib/workspace-data";
import { body, failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; task: string; trial: string }> };
export async function GET(request: Request, context: Context) {
  try {
    localRequest(request);
    const { id, task, trial } = await context.params;
    return json(
      await (cloudEnabled() ? getCloudReview : getReview)(
        id,
        task,
        Number(trial),
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    localRequest(request, true);
    const { id, task, trial } = await context.params;
    return json(
      await (cloudEnabled() ? saveCloudReview : saveReview)(
        id,
        task,
        Number(trial),
        await body(request, 40000),
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
