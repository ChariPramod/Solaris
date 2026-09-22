import { readRun, safeFile, RESULTS_ROOT } from "@/lib/store";
import {
  cloudEnabled,
  readCloudRun,
  readCloudArtifact,
} from "@/lib/cloud-artifacts";
import { failure, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    localRequest(request);
    const { id } = await context.params;
    const cloud = cloudEnabled();
    await (cloud ? readCloudRun : readRun)(id);
    const bytes = cloud
      ? await readCloudArtifact(id, "results.json", 16 * 1024 * 1024)
      : await safeFile(RESULTS_ROOT, [id, "results.json"], 16 * 1024 * 1024);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${id}.json"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return failure(e);
  }
}
