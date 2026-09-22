import test from "node:test";
import assert from "node:assert/strict";
import { ZodError } from "zod";
import { checkCloudReadiness } from "../lib/cloud-readiness";
import type { Readiness } from "../lib/types";

const setup = {
  tasks: ["T01", "T02"],
  trials: 2,
  concurrency: 1,
  maxInfraFailures: 1,
  provider: "claude",
  modelId: "",
};
const env = {
  SOLARI_API_KEY: "private-desktop-key",
  ANTHROPIC_API_KEY: "private-claude-key",
  GAUNTLET_SOURCE_REVISION: "a".repeat(40),
};
const storage = async () => ({ keys: [], truncated: false });
const status = (result: Readiness, name: string) =>
  result.checks.find((check) => check.name === name)?.status;

test("strict raw and legacy live envelopes yield identical cloud checks", async () => {
  const calls: unknown[] = [];
  const deps = {
    env,
    listKeys: async (prefix: string, limit?: number) => {
      calls.push([prefix, limit]);
      return storage();
    },
  };
  const raw = await checkCloudReadiness(setup, deps);
  const wrapped = await checkCloudReadiness({ setup, dryRun: false }, deps);
  assert.deepEqual(raw, wrapped);
  assert.equal(raw.ready, true);
  assert.equal(raw.planned_trials, 4);
  assert.match(raw.scope, /credentials are not exercised/);
  assert.doesNotMatch(
    JSON.stringify(raw),
    /private-desktop-key|private-claude-key/,
  );
  assert.deepEqual(calls, [
    ["jobs/", 1],
    ["jobs/", 1],
  ]);
});

test("ambiguous, unknown and dry envelopes reject as Zod input errors before storage", async () => {
  let calls = 0;
  const deps = {
    env,
    listKeys: async () => {
      calls++;
      return storage();
    },
  };
  for (const input of [
    null,
    { ...setup, extra: true },
    { setup, dryRun: true },
    { setup },
    { setup, dryRun: "false" },
    { setup, dryRun: false, extra: true },
    { setup: { ...setup, tasks: ["T01", "T01"] }, dryRun: false },
    { ...setup, setup, dryRun: false },
  ]) {
    await assert.rejects(checkCloudReadiness(input, deps), ZodError);
  }
  assert.equal(calls, 0);
});

test("missing and whitespace-only credentials fail without assuming provider authentication", async () => {
  for (const credentials of [
    {},
    { SOLARI_API_KEY: " \n\t", ANTHROPIC_API_KEY: "  " },
  ]) {
    const result = await checkCloudReadiness(setup, {
      env: {
        ...credentials,
        GAUNTLET_SOURCE_REVISION: env.GAUNTLET_SOURCE_REVISION,
      },
      listKeys: storage,
    });
    assert.equal(result.ready, false);
    assert.equal(status(result, "Computer provider"), "fail");
    assert.equal(status(result, "Model provider"), "fail");
    assert.equal(status(result, "Durable storage"), "pass");
  }
});

test("OpenAI uses its own key and requires an explicit model", async () => {
  const missing = await checkCloudReadiness(
    { ...setup, provider: "openai" },
    { env, listKeys: storage },
  );
  assert.equal(status(missing, "Model provider"), "fail");
  assert.equal(status(missing, "Model"), "fail");
  const ready = await checkCloudReadiness(
    { ...setup, provider: "openai", modelId: "selected-model" },
    {
      env: {
        SOLARI_API_KEY: env.SOLARI_API_KEY,
        OPENAI_API_KEY: "private-openai",
        GAUNTLET_SOURCE_REVISION: env.GAUNTLET_SOURCE_REVISION,
      },
      listKeys: storage,
    },
  );
  assert.equal(ready.ready, true);
  assert.doesNotMatch(JSON.stringify(ready), /private-openai/);
});

test("storage failure is a failed check with sanitized diagnostics rather than a readiness pass", async () => {
  const result = await checkCloudReadiness(setup, {
    env,
    listKeys: async () => {
      throw new Error("SDK private-storage-token");
    },
  });
  assert.equal(result.ready, false);
  assert.equal(status(result, "Durable storage"), "fail");
  assert.equal(status(result, "Execution source"), "pass");
  assert.doesNotMatch(JSON.stringify(result), /SDK|private-storage-token/);
});

test("source requires a full SHA and follows the same explicit-override precedence as execution", async () => {
  for (const revision of [
    undefined,
    "main",
    "b".repeat(39),
    "g".repeat(40),
    " ",
  ]) {
    const result = await checkCloudReadiness(setup, {
      env: { ...env, GAUNTLET_SOURCE_REVISION: revision },
      listKeys: storage,
    });
    assert.equal(result.ready, false);
    assert.equal(status(result, "Execution source"), "fail");
  }
  const fallback = await checkCloudReadiness(setup, {
    env: {
      ...env,
      GAUNTLET_SOURCE_REVISION: undefined,
      VERCEL_GIT_COMMIT_SHA: "B".repeat(40),
    },
    listKeys: storage,
  });
  assert.equal(fallback.ready, true);
  const invalidOverride = await checkCloudReadiness(setup, {
    env: {
      ...env,
      GAUNTLET_SOURCE_REVISION: "main",
      VERCEL_GIT_COMMIT_SHA: "b".repeat(40),
    },
    listKeys: storage,
  });
  assert.equal(status(invalidOverride, "Execution source"), "fail");
});
