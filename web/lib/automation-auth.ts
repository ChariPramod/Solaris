import { cloudOrigin } from "./cloud-auth";
import { integrationTokens, type IntegrationScope } from "./integration-tokens";
import { StoreError } from "./store";

/** Machine credentials are scoped independently of the owner browser session. */
export async function automationRequest(
  request: Request,
  scope: IntegrationScope,
) {
  if (process.env.GAUNTLET_STORAGE !== "vercel")
    throw new StoreError("Automation API requires the cloud workspace.", 400);
  const origin = cloudOrigin();
  if (
    request.headers.get("host") !== new URL(origin).host ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (request.headers.has("origin") && request.headers.get("origin") !== origin)
  )
    throw new StoreError("Use the configured Solaris API origin.", 403);
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (solaris_[A-Za-z0-9_-]{43})$/.exec(header);
  if (!match)
    throw new StoreError(
      "Use a scoped Solaris API token in the Authorization header.",
      401,
    );
  if (
    request.method !== "GET" &&
    !request.headers.get("content-type")?.startsWith("application/json")
  )
    throw new StoreError("Expected application/json.", 415);
  return integrationTokens.authenticate(match[1], scope);
}
