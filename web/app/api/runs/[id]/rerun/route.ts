import { recordAttempt } from "@/lib/workspace-data";
import { launchDryRun } from "@/lib/harness";
import { readRun } from "@/lib/store";
import { body, failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    localRequest(request, true);
    const { id } = await context.params;
    await readRun(id);
    const result = await launchDryRun(await body(request));
    if (result.id) {
      try {
        await recordAttempt(id, result.id);
      } catch {
        return json({
          ...result,
          warning:
            "The new run was saved, but its attempt link could not be saved. Both runs remain independently available.",
        });
      }
    }
    return json(result);
  } catch (e) {
    return failure(e);
  }
}
