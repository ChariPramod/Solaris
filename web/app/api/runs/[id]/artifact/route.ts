import { readRun, safeFile, RESULTS_ROOT, StoreError } from "@/lib/store";
import { failure, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    localRequest(request);
    const { id } = await context.params;
    const p = new URL(request.url).searchParams;
    const task = p.get("task") || "";
    const trial = p.get("trial") || "";
    const name = p.get("name") || "";
    if (
      !/^T\d{2}$/.test(task) ||
      !/^\d{1,5}$/.test(trial) ||
      !/^(?:\d{3,6}|final)\.jpg$/.test(name)
    )
      throw new StoreError("Invalid screenshot path.");
    const run = await readRun(id);
    if (
      !run.records.some((r) => r.task_id === task && r.trial === Number(trial))
    )
      throw new StoreError("Trial not found.", 404);
    const image = await safeFile(
      RESULTS_ROOT,
      [id, task, String(Number(trial)), name],
      10 * 1024 * 1024,
    );
    if (image[0] !== 0xff || image[1] !== 0xd8)
      throw new StoreError("Screenshot is not a valid JPEG.", 415);
    return new Response(new Uint8Array(image), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return failure(e);
  }
}
