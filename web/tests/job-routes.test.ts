import test from "node:test";
import assert from "node:assert/strict";
import { GET as listJobs } from "../app/api/jobs/route";
import { GET as getJob } from "../app/api/jobs/[id]/route";
import { GET as listMachineJobs } from "../app/api/automation/v1/jobs/route";
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
  process.env.GAUNTLET_ADMIN_KEY = "test-jobs-only-".repeat(4);
  process.env.GAUNTLET_PUBLIC_ORIGIN = "https://solaris.example";
});
test.after(() => {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});
function request(query: string, authenticated = false, extra = {}) {
  return new Request(`https://solaris.example/api/jobs${query}`, {
    headers: {
      host: "solaris.example",
      ...(authenticated
        ? { cookie: `${SESSION_COOKIE}=${createSession()}` }
        : {}),
      ...extra,
    },
  });
}

test("job history, reservation visibility and detail authenticate before reading storage", async () => {
  assert.equal((await listJobs(request("?view=reserved"))).status, 401);
  assert.equal((await listMachineJobs(request("?view=reserved"))).status, 401);
  assert.equal(
    (
      await getJob(request("/id"), {
        params: Promise.resolve({ id: "invalid" }),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await listJobs(
        request("?limit=1", true, { "sec-fetch-site": "cross-site" }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await getJob(request("/id", true, { host: "evil.example" }), {
        params: Promise.resolve({ id: "invalid" }),
      })
    ).status,
    403,
  );
});

test("authenticated jobs reject malformed cursors, views and identities before reading storage", async () => {
  for (const query of [
    "?limit=201",
    "?view=reserved&cursor=x",
    "?view=reserved&view=history",
    "?cursor=",
  ]) {
    const response = await listJobs(request(query, true));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(
    (
      await getJob(request("/invalid", true), {
        params: Promise.resolve({ id: "invalid" }),
      })
    ).status,
    400,
  );
});
