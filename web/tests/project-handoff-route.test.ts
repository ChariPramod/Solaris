import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "../app/api/projects/[id]/handoff/route";
import { createSession, SESSION_COOKIE } from "../lib/cloud-auth";

const names = [
  "GAUNTLET_STORAGE",
  "GAUNTLET_ADMIN_KEY",
  "GAUNTLET_PUBLIC_ORIGIN",
];
const original = Object.fromEntries(
  names.map((name) => [name, process.env[name]]),
);
test.before(() => {
  process.env.GAUNTLET_STORAGE = "vercel";
  process.env.GAUNTLET_ADMIN_KEY = "test-handoff-only-".repeat(4);
  process.env.GAUNTLET_PUBLIC_ORIGIN = "https://solaris.example";
});
test.after(() => {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});
const context = {
  params: Promise.resolve({ id: `project_${"a".repeat(32)}` }),
};
function request(query: string, authenticated = false, extra = {}) {
  return new Request(
    `https://solaris.example/api/projects/project/handoff?${query}`,
    {
      headers: {
        host: "solaris.example",
        ...(authenticated
          ? { cookie: `${SESSION_COOKIE}=${createSession()}` }
          : {}),
        ...extra,
      },
    },
  );
}
test("project handoff requires the owner session and rejects cross-site access before querying storage", async () => {
  assert.equal((await GET(request("revision=2"), context)).status, 401);
  assert.equal(
    (
      await GET(
        request("revision=2", true, { "sec-fetch-site": "cross-site" }),
        context,
      )
    ).status,
    403,
  );
  assert.equal(
    (await GET(request("revision=2", true, { host: "evil.example" }), context))
      .status,
    403,
  );
});
test("authenticated handoff requests reject invalid query formats before querying storage", async () => {
  for (const query of [
    "",
    "revision=2&includeNotes=true",
    "revision=2&format=html",
    "revision=2&revision=2",
  ]) {
    const response = await GET(request(query, true), context);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
