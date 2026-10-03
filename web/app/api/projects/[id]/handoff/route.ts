import { cloudEnabled } from "@/lib/cloud-artifacts";
import { failure, localRequest } from "@/lib/http";
import {
  collectProjectHandoff,
  parseHandoffQuery,
  renderProjectHandoff,
} from "@/lib/project-handoff";
import { StoreError } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    localRequest(request);
    if (!cloudEnabled())
      throw new StoreError("Client projects require the cloud workspace.", 404);
    const { id } = await context.params;
    const { revision, format } = parseHandoffQuery(
      new URL(request.url).searchParams,
    );
    const handoff = await collectProjectHandoff(id, revision, request.signal);
    return new Response(
      format === "json"
        ? JSON.stringify(handoff, null, 2) + "\n"
        : renderProjectHandoff(handoff),
      {
        headers: {
          "Content-Type":
            format === "json"
              ? "application/json; charset=utf-8"
              : "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${id}-r${revision}-handoff.${format === "json" ? "json" : "md"}"`,
          "Cache-Control": "no-store, no-transform",
          "X-Content-Type-Options": "nosniff",
          "X-Solaris-Project-Revision": String(revision),
          "X-Solaris-Unavailable-Runs": String(handoff.unavailableRuns),
        },
      },
    );
  } catch (error) {
    return failure(error);
  }
}
