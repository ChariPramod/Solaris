import test from "node:test";
import assert from "node:assert/strict";
import { configuration, runEvaluation } from "../../scripts/solaris-ci.mjs";
const id = `cloud_${"a".repeat(32)}`;
const base = {
  ...configuration({ SOLARIS_MODE: "dry-run" }),
  url: "https://solaris.example",
  token: `solaris_${"a".repeat(43)}`,
  idempotencyKey: "ci-request-12345678",
  policy: { schema_version: 1 },
  pollMs: 0,
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
test("CI client safely retries ambiguous launch with the same key, polls, then uses actual gate verdict", async () => {
  const calls: { url: string; options: any }[] = [];
  let attempts = 0;
  const result = await runEvaluation(base, {
    sleep: async () => {},
    log: () => {},
    fetch: async (url: string, options: any) => {
      calls.push({ url, options });
      if (url.endsWith("/jobs")) {
        if (!attempts++) throw new Error("ambiguous");
        return response({ id, status: "running" }, 202);
      }
      if (url.endsWith("/gate"))
        return response({
          passed: false,
          run: { folder: `/vercel/sandbox/results/${id}` },
          checks: [{ passed: false }],
        });
      return response({ id, status: "complete" });
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 4);
  assert.equal(
    calls[0].options.headers["Idempotency-Key"],
    calls[1].options.headers["Idempotency-Key"],
  );
  assert.equal(calls[0].options.redirect, "error");
});
test("CI client refuses to gate failed jobs and never repeats an assessment", async () => {
  let calls = 0;
  await assert.rejects(
    runEvaluation(base, {
      log: () => {},
      fetch: async () => {
        calls++;
        return response({ id, status: "failed" });
      },
    }),
    /ended as failed/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    runEvaluation(base, {
      log: () => {},
      fetch: async (url: string) => {
        calls++;
        if (url.endsWith("/jobs")) return response({ id, status: "complete" });
        throw new Error("private transport details");
      },
    }),
    /could not be confirmed/,
  );
  assert.equal(calls, 2);
});
test("CI client fails closed on contradictory gate output, redirects and unsafe origin", async () => {
  await assert.rejects(
    runEvaluation(base, {
      log: () => {},
      fetch: async (url: string) =>
        url.endsWith("/jobs")
          ? response({ id, status: "complete" })
          : response({
              passed: true,
              run: { folder: `/vercel/sandbox/results/${id}` },
              checks: [{ passed: false }],
            }),
    }),
    /contradictory/,
  );
  await assert.rejects(
    runEvaluation({ ...base, url: "https://user:pass@example.com" }),
    /HTTPS workspace/,
  );
  assert.throws(() => configuration({ SOLARIS_TASKS: "T01,T01" }), /unique/);
});
