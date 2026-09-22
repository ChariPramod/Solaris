import { after } from "next/server";
import { Sandbox } from "@vercel/sandbox";
import { createIngestHandler } from "@/lib/cloud-ingest";

export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = createIngestHandler({
  scheduleStop(name) {
    after(async () => {
      // Completion is already durable. A stop outage must not roll back evidence.
      try {
        await (await Sandbox.get({ name })).stop();
      } catch {}
    });
  },
});
