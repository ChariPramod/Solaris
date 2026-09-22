import test from "node:test";
import assert from "node:assert/strict";
import {
  authenticated,
  checkCloudOrigin,
  cloudRequest,
  createSession,
  SESSION_COOKIE,
  SESSION_SECONDS,
  validAccessKey,
} from "../lib/cloud-auth";
const original = {
  key: process.env.GAUNTLET_ADMIN_KEY,
  origin: process.env.GAUNTLET_PUBLIC_ORIGIN,
};
test.before(() => {
  process.env.GAUNTLET_ADMIN_KEY = "test-key-only-".repeat(5);
  process.env.GAUNTLET_PUBLIC_ORIGIN = "https://solaris.example";
});
test.after(() => {
  for (const [key, value] of [
    ["GAUNTLET_ADMIN_KEY", original.key],
    ["GAUNTLET_PUBLIC_ORIGIN", original.origin],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
});
const request = (cookie = "", extra = {}) =>
  new Request("https://solaris.example/api/runs", {
    headers: { host: "solaris.example", cookie, ...extra },
  });
test("signed sessions expire, reject tampering, and are invalidated by key rotation", () => {
  const now = Date.now();
  const token = createSession(now);
  const cookie = `${SESSION_COOKIE}=${token}`;
  assert.equal(authenticated(request(cookie), now), true);
  assert.equal(
    authenticated(request(cookie), now + SESSION_SECONDS * 1000),
    false,
  );
  assert.equal(
    authenticated(request(`${SESSION_COOKIE}=${token.slice(0, -1)}x`), now),
    false,
  );
  assert.equal(authenticated(request(), now), false);
  const old = process.env.GAUNTLET_ADMIN_KEY;
  process.env.GAUNTLET_ADMIN_KEY = "rotated-key-".repeat(5);
  assert.equal(authenticated(request(cookie), now), false);
  process.env.GAUNTLET_ADMIN_KEY = old;
});
test("access key compares full values and missing configuration fails closed", () => {
  assert.equal(validAccessKey(process.env.GAUNTLET_ADMIN_KEY), true);
  assert.equal(validAccessKey("wrong"), false);
  assert.equal(validAccessKey({}), false);
  const old = process.env.GAUNTLET_ADMIN_KEY;
  delete process.env.GAUNTLET_ADMIN_KEY;
  assert.throws(() => createSession(), /not configured/);
  process.env.GAUNTLET_ADMIN_KEY = old;
});
test("cloud API requires signed session and exact same-origin JSON writes", () => {
  const cookie = `${SESSION_COOKIE}=${createSession()}`;
  assert.throws(() => cloudRequest(request()), /Sign in/);
  assert.doesNotThrow(() => cloudRequest(request(cookie)));
  assert.throws(() => cloudRequest(request(cookie), true), /submit changes/);
  assert.throws(
    () => checkCloudOrigin(request(cookie, { host: "evil.example" })),
    /published workspace/,
  );
  assert.throws(
    () =>
      cloudRequest(
        request(cookie, {
          origin: "https://evil.example",
          "content-type": "application/json",
        }),
        true,
      ),
    /submit changes/,
  );
  assert.doesNotThrow(() =>
    cloudRequest(
      request(cookie, {
        origin: "https://solaris.example",
        "content-type": "application/json",
      }),
      true,
    ),
  );
});
