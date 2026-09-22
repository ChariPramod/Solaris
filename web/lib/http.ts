import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { StoreError } from "./store";
import { cloudRequest } from "./cloud-auth";
export function localRequest(request: Request, write = false) {
  if (process.env.GAUNTLET_STORAGE === "vercel")
    return cloudRequest(request, write);
  const host = request.headers.get("host");
  const loopback = ["localhost", "127.0.0.1", "[::1]"];
  let hostUrl: URL;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    throw new StoreError("Invalid local host.", 403);
  }
  if (
    !host ||
    !loopback.includes(hostUrl.hostname) ||
    hostUrl.host !== host ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new StoreError("This workspace is available only on localhost.", 403);
  if (write) {
    let origin: URL;
    try {
      origin = new URL(request.headers.get("origin") || "");
    } catch {
      throw new StoreError(
        "Use the local workspace to submit this request.",
        403,
      );
    }
    if (
      origin.host !== host ||
      !["http:", "https:"].includes(origin.protocol) ||
      !request.headers.get("content-type")?.startsWith("application/json")
    )
      throw new StoreError(
        "Use the local workspace to submit this request.",
        403,
      );
  }
}
export function json(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export function failure(error: unknown) {
  if (error instanceof ZodError)
    return json(
      { error: "Invalid request. Check task selection and limits." },
      400,
    );
  if (error instanceof StoreError)
    return json({ error: error.message }, error.status);
  return json(
    {
      error:
        "This operation is unavailable. Refresh or inspect the saved run in your terminal.",
    },
    500,
  );
}
export async function body(request: Request, limit = 8192) {
  const reader = request.body?.getReader();
  if (!reader) throw new StoreError("Expected a JSON request.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new StoreError("Request is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StoreError("Expected a JSON request.");
  }
}
