import { createHmac, timingSafeEqual } from "node:crypto";
import { StoreError } from "./store";

export const SESSION_COOKIE = "__Host-solaris";
export const SESSION_SECONDS = 12 * 60 * 60;
function secret() {
  const key = process.env.GAUNTLET_ADMIN_KEY;
  if (!key || key.length < 32)
    throw new StoreError("Workspace sign-in is not configured.", 503);
  return key;
}
function signature(value: string) {
  return createHmac("sha256", secret()).update(value).digest("hex");
}
function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function validAccessKey(value: unknown) {
  return (
    typeof value === "string" && equal(signature(value), signature(secret()))
  );
}
export function createSession(now = Date.now()) {
  const expires = String(Math.floor(now / 1000) + SESSION_SECONDS);
  return `${expires}.${signature(expires)}`;
}
export function authenticated(request: Request, now = Date.now()) {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!token || !/^\d{10}\.[a-f0-9]{64}$/.test(token)) return false;
  const [expires, digest] = token.split(".");
  const remaining = Number(expires) - Math.floor(now / 1000);
  return (
    remaining > 0 &&
    remaining <= SESSION_SECONDS &&
    equal(digest, signature(expires))
  );
}
export function cloudOrigin() {
  const value = process.env.GAUNTLET_PUBLIC_ORIGIN;
  if (!value)
    throw new StoreError("Workspace public origin is not configured.", 503);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value)
    throw new StoreError("Workspace public origin is invalid.", 503);
  return url.origin;
}
export function checkCloudOrigin(request: Request, write = false) {
  const origin = cloudOrigin();
  if (
    request.headers.get("host") !== new URL(origin).host ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new StoreError(
      "Use the published workspace to make this request.",
      403,
    );
  if (
    write &&
    (request.headers.get("origin") !== origin ||
      !request.headers.get("content-type")?.startsWith("application/json"))
  )
    throw new StoreError("Use the published workspace to submit changes.", 403);
}
export function cloudRequest(request: Request, write = false) {
  checkCloudOrigin(request, write);
  if (!authenticated(request))
    throw new StoreError("Sign in to access this workspace.", 401);
}
