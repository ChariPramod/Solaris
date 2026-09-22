import path from "node:path";
import { readRun, RESULTS_ROOT, StoreError } from "@/lib/store";
import { invoke } from "@/lib/harness";
import { failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    localRequest(request);
    const { id } = await context.params;
    await readRun(id);
    const result = await invoke([
      "audit",
      path.join(RESULTS_ROOT, id),
      "--json",
    ]);
    if (result.timedOut || ![0, 1].includes(result.code ?? -1))
      throw new StoreError(
        "Audit could not finish. Saved results are still available.",
        503,
      );
    return json(JSON.parse(result.stdout));
  } catch (e) {
    return failure(e);
  }
}
