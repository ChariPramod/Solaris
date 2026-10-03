import test from "node:test";
import assert from "node:assert/strict";
import { GET as listRuns } from "../app/api/automation/v1/runs/route";
import { POST as startJob } from "../app/api/automation/v1/jobs/route";
import {
  GET as listTokens,
  POST as createToken,
} from "../app/api/integrations/tokens/route";

test("machine endpoints reject missing tokens, owner cookies and cross-origin calls before storage", async () => {
  const original = { ...process.env };
  Object.assign(process.env, {
    GAUNTLET_STORAGE: "vercel",
    GAUNTLET_PUBLIC_ORIGIN: "https://solaris.example",
    GAUNTLET_ADMIN_KEY: "test-only-".repeat(8),
  });
  try {
    const request = (method = "GET", extra = {}) =>
      new Request("https://solaris.example/api/automation/v1/runs", {
        method,
        headers: {
          host: "solaris.example",
          "content-type": "application/json",
          ...extra,
        },
        ...(method === "GET" ? {} : { body: "{}" }),
      });
    assert.equal((await listRuns(request())).status, 401);
    assert.equal(
      (
        await listRuns(
          request("GET", { cookie: "__Host-solaris=owner-cookie" }),
        )
      ).status,
      401,
    );
    assert.equal(
      (await listRuns(request("GET", { origin: "https://evil.example" })))
        .status,
      403,
    );
    assert.equal((await startJob(request("POST"))).status, 401);
    assert.equal((await listTokens(request())).status, 401);
    assert.equal(
      (
        await createToken(
          request("POST", { origin: "https://solaris.example" }),
        )
      ).status,
      401,
    );
  } finally {
    for (const name of [
      "GAUNTLET_STORAGE",
      "GAUNTLET_PUBLIC_ORIGIN",
      "GAUNTLET_ADMIN_KEY",
    ]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});
