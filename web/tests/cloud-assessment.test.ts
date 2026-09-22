import test from "node:test";
import assert from "node:assert/strict";
import { assessCloudGate, compareCloudRuns } from "../lib/cloud-assessment";
import { StoreError } from "../lib/store";

const descriptor = {
  folder: "/results/run",
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
const comparison = {
  schema_version: 1,
  candidate: descriptor,
  baseline: descriptor,
  warnings: [],
  configuration_differences: [],
  tasks: [],
  slots: [],
  summary: {
    baseline: metrics,
    candidate: metrics,
    transitions: { improved: 0, regressed: 0, unchanged: 1, inconclusive: 0 },
  },
};
const policy = {
  schema_version: 1,
  require_live: true,
  required_tasks: [],
  min_pass_rate: 1,
};
const gate = {
  schema_version: 1,
  passed: false,
  run: descriptor,
  policy,
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

function fixture(
  options: {
    code?: number;
    output?: string;
    installCode?: number;
    stopFails?: boolean;
    commandFails?: boolean;
  } = {},
) {
  const calls: Array<{
    cmd: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
  }> = [];
  const written: Array<{ path: string; content: Buffer }> = [];
  const created: unknown[] = [];
  let stops = 0;
  const deps = {
    read: async (_id: string) => [
      { path: "results.json", content: Buffer.from("{}") },
      { path: "T01/trial_1/result.json", content: Buffer.from("{}") },
    ],
    revision: (): string | undefined => "a".repeat(40),
    create: async (config: unknown) => {
      created.push(config);
      return {
        runCommand: async (args: (typeof calls)[number]) => {
          calls.push(args);
          const install = calls.length === 1;
          if (!install && options.commandFails)
            throw new Error("private provider details");
          return {
            exitCode: install
              ? (options.installCode ?? 0)
              : (options.code ?? 0),
            async *logs() {
              yield { stream: "stderr", data: "private provider details" };
              yield {
                stream: "stdout",
                data: options.output ?? JSON.stringify(comparison),
              };
            },
          };
        },
        writeFiles: async (files: typeof written) => {
          written.push(...files);
        },
        stop: async () => {
          stops++;
          if (options.stopFails) throw new Error("stop unavailable");
        },
      };
    },
  };
  return { deps, calls, written, created, stops: () => stops };
}

test("cloud comparison runs pinned Python CLI with only evidence and no provider environment", async () => {
  const f = fixture();
  const value = await compareCloudRuns("candidate", "base", f.deps);
  assert.equal(value.summary.transitions.unchanged, 1);
  assert.equal(f.stops(), 1);
  const config = f.created[0] as {
    source: { revision: string };
    runtime: string;
    env: Record<string, string>;
    timeout: number;
  };
  assert.equal(config.source.revision, "a".repeat(40));
  assert.equal(config.runtime, "python3.13");
  assert.equal(config.timeout, 210000);
  assert.deepEqual(config.env, { PIP_DISABLE_PIP_VERSION_CHECK: "1" });
  assert.deepEqual(f.calls[0].args, [
    "-m",
    "pip",
    "install",
    "--quiet",
    "-e",
    ".",
  ]);
  assert.deepEqual(f.calls[1].args, [
    "-m",
    "gauntlet",
    "compare",
    "/vercel/sandbox/results/candidate",
    "--baseline",
    "/vercel/sandbox/results/base",
    "--json",
  ]);
  assert.equal(f.written.length, 4);
});

test("failed gate is valid output and policy is written separately", async () => {
  const f = fixture({ code: 1, output: JSON.stringify(gate) });
  const value = await assessCloudGate(
    "candidate",
    { policy, baseline: "base" },
    f.deps,
  );
  assert.equal(value.passed, false);
  assert.deepEqual(JSON.parse(f.written.at(-1)!.content.toString()), policy);
  assert.ok(f.calls[1].args.includes("gate"));
  assert.equal(f.stops(), 1);
});

test("identifiers, policies, source revision and evidence paths validate before worker allocation", async () => {
  const f = fixture();
  await assert.rejects(compareCloudRuns("../escape", "base", f.deps));
  await assert.rejects(
    assessCloudGate(
      "candidate",
      { policy: { ...policy, max_regressions: 0 } },
      f.deps,
    ),
  );
  f.deps.revision = () => undefined;
  await assert.rejects(compareCloudRuns("candidate", "base", f.deps));
  f.deps.revision = () => "main";
  await assert.rejects(compareCloudRuns("candidate", "base", f.deps));
  f.deps.revision = () => "a".repeat(40);
  for (const bad of [
    "../results.json",
    "nested//result.json",
    "arbitrary.py",
    "\\result.json",
  ])
    await assert.rejects(
      compareCloudRuns("candidate", "base", {
        ...f.deps,
        read: async () => [{ path: bad, content: Buffer.from("{}") }],
      }),
    );
  await assert.rejects(
    compareCloudRuns("candidate", "base", { ...f.deps, read: async () => [] }),
  );
  assert.equal(f.created.length, 0);
});

test("CLI validation error is surfaced as 422 and worker is stopped", async () => {
  const f = fixture({
    code: 2,
    output: JSON.stringify({ error: "Different task fingerprints" }),
  });
  await assert.rejects(
    compareCloudRuns("candidate", "base", f.deps),
    (e) =>
      e instanceof StoreError &&
      e.status === 422 &&
      e.message === "Different task fingerprints",
  );
  assert.equal(f.stops(), 1);
});

test("invalid output, conflicting gate verdict and worker failures cannot become successful assessments", async () => {
  for (const options of [
    { output: "{}" },
    { output: "not-json" },
    { installCode: 1 },
    { commandFails: true },
    { code: 9, output: "private" },
    { output: "x".repeat(2 * 1024 * 1024) },
  ]) {
    const f = fixture(options);
    await assert.rejects(
      compareCloudRuns("candidate", "base", f.deps),
      (e) =>
        e instanceof StoreError &&
        e.status === 503 &&
        !e.message.includes("private"),
    );
    assert.equal(f.stops(), 1);
  }
  const f = fixture({ code: 0, output: JSON.stringify(gate) });
  await assert.rejects(assessCloudGate("candidate", { policy }, f.deps));
  assert.equal(f.stops(), 1);
});

test("stop failures preserve successful result with an explicit cleanup warning", async () => {
  const f = fixture({ stopFails: true });
  const value = await compareCloudRuns("candidate", "base", f.deps);
  assert.match(value.warnings[0], /cleanup was not acknowledged/);
  assert.equal(f.stops(), 1);
});

test("duplicate files are rejected and same-run reads are deduplicated", async () => {
  const f = fixture();
  await assert.rejects(
    compareCloudRuns("candidate", "base", {
      ...f.deps,
      read: async () => [
        { path: "results.json", content: Buffer.from("{}") },
        { path: "results.json", content: Buffer.from("{}") },
      ],
    }),
  );
  assert.equal(f.created.length, 0);
  await compareCloudRuns("candidate", "candidate", f.deps);
  assert.equal(f.written.length, 2);
});
