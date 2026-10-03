import { cloudEnabled } from "@/lib/cloud-artifacts";
import {
  cloudExportSource,
  createEvidenceBundle,
  localExportSource,
} from "@/lib/evidence-export";
import { failure, localRequest } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    localRequest(request);
    const { id } = await context.params;
    const bundle = await createEvidenceBundle(
      id,
      cloudEnabled() ? cloudExportSource() : localExportSource(),
      new Date(),
      request.signal,
    );
    return new Response(bundle.stream, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${bundle.filename}"`,
        "Cache-Control": "no-store, no-transform",
        "X-Content-Type-Options": "nosniff",
        "X-Solaris-Snapshot": bundle.snapshot,
        "X-Solaris-File-Count": String(bundle.fileCount),
      },
    });
  } catch (error) {
    return failure(error);
  }
}
