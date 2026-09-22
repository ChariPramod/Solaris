import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { compareRuns, assessGate, gatePolicySchema } from "../lib/assessment";
import type { Run } from "../lib/types";
import { StoreError } from "../lib/store";
const result = (code: number, stdout: string, timedOut = false) => ({
  code,
  stdout,
  stderr: "private local diagnostics",
  timedOut,
});
const descriptor = {
  folder: "/results/test",
  run_id: "uuid",
  model: "dry-run",
  mode: "dry-run",
  status: "complete",
};
const metrics = {
  planned_trials: 1,
  recorded_trials: 1,
  eligible_trials: 1,
  passed_trials: 0,
  pass_rate: 0,
  coverage_complete: true,
  infra_errors: 0,
  cleanup_errors: 0,
  destructive_actions: 0,
  total_cost_usd: 0,
  known_cost_trials: 1,
  mean_wall_seconds: 0,
};
const group = {
  baseline: metrics,
  candidate: metrics,
  transitions: { improved: 0, regressed: 0, unchanged: 1, inconclusive: 0 },
};
const comparison = {
  schema_version: 1,
  baseline: descriptor,
  candidate: descriptor,
  summary: group,
  tasks: [],
  slots: [],
  warnings: [],
  configuration_differences: [],
};
const gate = {
  schema_version: 1,
  passed: false,
  run: descriptor,
  policy: {
    schema_version: 1,
    require_live: true,
    min_pass_rate: 1,
    required_tasks: [],
  },
  warnings: [],
  checks: [
    {
      name: "live",
      passed: false,
      actual: "dry-run",
      expected: "live",
      message: "Live evidence required",
    },
  ],
};
const read = async (id: string) => {
  if (!/^[a-z]+$/.test(id)) throw new StoreError("Invalid identifier");
  return { id } as Run;
};
test("comparison validates both IDs before executing; fixed arguments preserve candidate order", async () => {
  const calls: string[][] = [];
  const deps = {
    root: "/results",
    read,
    run: async (args: string[]) => {
      calls.push(args);
      return result(0, JSON.stringify(comparison));
    },
  };
  await assert.rejects(compareRuns("../bad", "base", deps));
  assert.equal(calls.length, 0);
  await compareRuns("candidate", "base", deps);
  assert.deepEqual(calls, [
    ["compare", "/results/candidate", "--baseline", "/results/base", "--json"],
  ]);
});
test("CLI validation, timeout and malformed-output errors remain explicit without leaking stderr", async () => {
  for (const response of [
    result(2, '{"error":"Different task fingerprints"}'),
    result(0, "broken"),
    result(0, "{}"),
    result(0, "[]"),
    result(0, "{}", true),
  ]) {
    await assert.rejects(
      compareRuns("candidate", "base", {
        root: "/results",
        read,
        run: async () => response,
      }),
      (e) => e instanceof StoreError && !e.message.includes("private"),
    );
  }
});
test("failed gate is a valid result; private temporary policy removed after success or failure", async () => {
  for (const fail of [false, true]) {
    let file = "";
    const deps = {
      root: "/results",
      read,
      run: async (args: string[]) => {
        file = args[args.indexOf("--policy") + 1];
        const policy = JSON.parse(await readFile(file, "utf8"));
        assert.equal(policy.require_live, true);
        assert.equal(policy.min_pass_rate, 1);
        if (fail) throw new Error("spawn failure");
        return result(1, JSON.stringify(gate));
      },
    };
    if (fail)
      await assert.rejects(
        assessGate("candidate", { policy: { schema_version: 1 } }, deps),
      );
    else
      assert.deepEqual(
        await assessGate("candidate", { policy: { schema_version: 1 } }, deps),
        gate,
      );
    assert.ok(file);
    await assert.rejects(access(file));
  }
});
test("policies reject duplicate tasks, nonfinite limits, unknown keys and regressions without baseline", async () => {
  for (const value of [
    { min_pass_rate: 1.1 },
    { max_total_cost_usd: Infinity },
    { max_regressions: -1 },
    { required_tasks: ["T01", "T01"] },
    { skip_audit: true },
  ])
    assert.equal(
      gatePolicySchema.safeParse({ schema_version: 1, ...value }).success,
      false,
    );
  await assert.rejects(
    assessGate(
      "candidate",
      { policy: { schema_version: 1, max_regressions: 0 } },
      {
        root: "/results",
        read,
        run: async () => {
          throw new Error("must not execute");
        },
      },
    ),
    /baseline/,
  );
});

test("gate rejects missing checks and conflicting CLI exit status", async () => {
  for (const response of [
    result(0, JSON.stringify(gate)),
    result(1, '{"passed":false}'),
  ])
    await assert.rejects(
      assessGate(
        "candidate",
        { policy: { schema_version: 1 } },
        { root: "/results", read, run: async () => response },
      ),
      /unreadable/,
    );
});
