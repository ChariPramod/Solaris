import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  listRuns,
  readRun,
  readTrial,
  parseActions,
  safeFile,
  validId,
} from "../lib/store";
import { passRate, summarizeRun, liveCommand } from "../lib/domain";
const manifest = {
  schema_version: 2,
  run_id: "same-original-id",
  created_at: "2026-09-21T00:00:00Z",
  mode: "dry-run",
  model: "dry-run",
  status: "stopped",
  planned_trials: 4,
  trials_per_task: 2,
  task_ids: ["T01", "T02"],
  records: [
    {
      task_id: "T01",
      trial: 1,
      tier: 1,
      model: "dry-run",
      mode: "dry-run",
      passed: false,
      steps: 0,
      wall_seconds: 0.1,
      termination: "error",
      failure_class: "infra_error",
      cleanup_error: null,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      evidence: {},
      artifacts: "T01/1",
    },
  ],
  tasks: {},
  configuration: {},
  stop_reason: {
    kind: "max_infra_failures",
    limit: 1,
    observed_failures: 1,
    task_id: "T01",
    trial: 1,
  },
};
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "gauntlet-web-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function save(root: string, id: string, data: unknown) {
  await mkdir(path.join(root, id), { recursive: true });
  await writeFile(path.join(root, id, "results.json"), JSON.stringify(data));
}
test("library isolates corrupt runs and identifies recovered exports by directory", async (t) => {
  const root = await fixture(t);
  await save(root, "valid", manifest);
  await save(root, "recovered", { ...manifest, status: "recovered" });
  await save(root, "broken", {});
  const lib = await listRuns(root);
  assert.equal(lib.runs.length, 2);
  assert.notEqual(lib.runs[0].id, lib.runs[1].id);
  assert.equal(lib.runs[0].run_id, lib.runs[1].run_id);
  assert.equal(lib.warnings.length, 1);
  assert.equal(lib.runs[0].cost, null);
  assert.equal(passRate(lib.runs[0]), null);
});
test("missing results root gives a useful empty library", async (t) => {
  const root = await fixture(t);
  assert.equal((await listRuns(path.join(root, "missing"))).runs.length, 0);
});
test("stopped plan and legacy optional fields survive normalization", async (t) => {
  const root = await fixture(t);
  await save(root, "run", manifest);
  const run = await readRun("run", root);
  assert.equal(run.planned_trials, 4);
  assert.equal(run.records.length, 1);
  assert.equal(run.records[0].failure_stage, undefined);
  assert.equal(run.stop_reason?.trial, 1);
});
test("rejects conflicting identities instead of displaying false coverage", async (t) => {
  const root = await fixture(t);
  await save(root, "run", {
    ...manifest,
    records: [manifest.records[0], manifest.records[0]],
  });
  await assert.rejects(readRun("run", root), /conflicting/);
});
test("invalid traversal identifiers are refused", () => {
  for (const id of ["..", "../outside", "x/y", "%2e%2e", "/tmp", "x\\y"])
    assert.throws(() => validId(id));
});
test("symlink, directory, oversized file, and FIFO artifacts are refused", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "file"), "1234");
  await symlink(path.join(root, "file"), path.join(root, "linked"));
  await mkdir(path.join(root, "dir"));
  execFileSync("mkfifo", [path.join(root, "pipe")]);
  await assert.rejects(safeFile(root, ["linked"], 100));
  await assert.rejects(safeFile(root, ["dir"], 100));
  await assert.rejects(safeFile(root, ["file"], 2));
  await assert.rejects(safeFile(root, ["pipe"], 100));
  await assert.rejects(safeFile(root, ["..", "file"], 100));
});
test("partial logs preserve good actions and reject unsafe shapes", () => {
  const value = parseActions(
    '{"step":1,"action":{"kind":"done","params":{}}}\n{"step":{"bad":true}}\n{"step":2',
  );
  assert.equal(value.frames.length, 1);
  assert.equal(value.warnings.length, 2);
});
test("missing evidence does not erase the saved verdict", async (t) => {
  const root = await fixture(t);
  await save(root, "run", manifest);
  const detail = await readTrial("run", "T01", 1, root);
  assert.equal(detail.trial.failure_class, "infra_error");
  assert.equal(detail.frames.length, 0);
  assert.equal(detail.screenshots.length, 0);
  assert.equal(detail.warnings.length, 1);
  await assert.rejects(readTrial("run", "T02", 1, root), /No result/);
});
test("cost stays unknown for incomplete or unpriced records", async (t) => {
  const root = await fixture(t);
  await save(root, "run", {
    ...manifest,
    planned_trials: 1,
    trials_per_task: 1,
    task_ids: ["T01"],
    records: [{ ...manifest.records[0], cost_usd: null }],
  });
  assert.equal(summarizeRun(await readRun("run", root)).cost, null);
});
test("command builder shell-quotes model identifiers", () => {
  const cmd = liveCommand({
    tasks: ["T01"],
    trials: 1,
    concurrency: 1,
    maxInfraFailures: 1,
    provider: "claude",
    modelId: "x'$(touch bad)",
  });
  assert.ok(cmd.includes("'x'\\''$(touch bad)'"));
  assert.ok(cmd.includes("--max-infra-failures 1"));
});
