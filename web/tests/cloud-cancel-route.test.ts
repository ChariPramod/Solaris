import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/jobs/[id]/cancel/route";
import { createSession, SESSION_COOKIE } from "../lib/cloud-auth";

test("cancel route requires an owner session, same origin, and a strict empty body", async () => {
  const keys = [
    "GAUNTLET_STORAGE",
    "GAUNTLET_ADMIN_KEY",
    "GAUNTLET_PUBLIC_ORIGIN",
  ];
  const saved = keys.map((key) => process.env[key]);
  Object.assign(process.env, {
    GAUNTLET_STORAGE: "vercel",
    GAUNTLET_ADMIN_KEY: "test-only-".repeat(8),
    GAUNTLET_PUBLIC_ORIGIN: "https://solaris.example",
  });
  try {
    const request = (
      cookie: string,
      origin = "https://solaris.example",
      body = "{}",
    ) =>
      new Request("https://solaris.example/api/jobs/invalid/cancel", {
        method: "POST",
        headers: {
          host: "solaris.example",
          origin,
          cookie,
          "content-type": "application/json",
        },
        body,
      });
    const context = { params: Promise.resolve({ id: "invalid" }) };
    assert.equal((await POST(request(""), context)).status, 401);
    const cookie = `${SESSION_COOKIE}=${createSession()}`;
    assert.equal(
      (await POST(request(cookie, "https://evil.example"), context)).status,
      403,
    );
    assert.equal(
      (await POST(request(cookie, undefined, '{"force":true}'), context))
        .status,
      400,
    );
    assert.equal((await POST(request(cookie), context)).status, 400);
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
  }
});
