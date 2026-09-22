import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
  rm,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  getReview,
  saveReview,
  listPresets,
  savePreset,
  recordAttempt,
  getAttempts,
} from "../lib/workspace-data";
import { StoreError } from "../lib/store";

const record = {
  task_id: "T01",
  trial: 1,
  tier: 1,
  model: "dry-run",
  mode: "dry-run",
  passed: false,
  steps: 0,
  wall_seconds: 0.1,
  termination: "max_steps",
  failure_class: "task_failure",
  cleanup_error: null,
  cost_usd: 0,
  tokens_in: 0,
  tokens_out: 0,
  evidence: {},
  artifacts: "T01/1",
};
const setup = {
  tasks: ["T01"],
  trials: 1,
  concurrency: 1,
  maxInfraFailures: 1,
  provider: "claude" as const,
  modelId: "",
};
async function fixture(t: TestContext) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workspace-data-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await saveRun(projectRoot, "run", "original-uuid");
  return { projectRoot, lockTimeoutMs: 100 };
}
async function saveRun(root: string, id: string, uuid: string) {
  const folder = path.join(root, "results", id);
  await mkdir(path.join(folder, "T01", "1"), { recursive: true });
  await writeFile(
    path.join(folder, "results.json"),
    JSON.stringify({
      schema_version: 2,
      run_id: uuid,
      created_at: "2026-09-21T00:00:00Z",
      mode: "dry-run",
      model: "dry-run",
      status: "complete",
      planned_trials: 1,
      trials_per_task: 1,
      task_ids: ["T01"],
      records: [record],
    }),
  );
  await writeFile(
    path.join(folder, "T01/1/result.json"),
    JSON.stringify(record),
  );
  await writeFile(
    path.join(folder, "T01/1/task.json"),
    JSON.stringify({
      definition: { id: "T01", name: "Example" },
      sha256: "example",
    }),
  );
}
const status = (code: number) => (e: unknown) =>
  e instanceof StoreError && e.status === code;
const reviewInput = (digest: string, revision = 0) => ({
  revision,
  evidenceDigest: digest,
  verdict: "needs-investigation",
  category: "agent",
  note: "Investigate missed click.",
  reviewer: "Reviewer",
});

test("empty GETs do not create metadata; review changes preserve original evidence and full history", async (t) => {
  const options = await fixture(t);
  const original = await readFile(
    path.join(options.projectRoot, "results/run/T01/1/result.json"),
  );
  const empty = await getReview("run", "T01", 1, options);
  assert.equal(empty.revision, 0);
  assert.equal(empty.stale, false);
  assert.deepEqual(await listPresets(options), []);
  assert.deepEqual(await getAttempts("run", options), {
    parents: [],
    children: [],
  });
  await assert.rejects(
    lstat(path.join(options.projectRoot, ".gauntlet-workspace")),
    { code: "ENOENT" },
  );
  const saved = await saveReview(
    "run",
    "T01",
    1,
    reviewInput(empty.evidenceDigest),
    options,
  );
  assert.equal(saved.revision, 1);
  const next = await saveReview(
    "run",
    "T01",
    1,
    { ...reviewInput(empty.evidenceDigest, 1), note: "Fixed in another run" },
    options,
  );
  assert.equal(next.history[0].note, "Investigate missed click.");
  assert.equal(next.history.length, 2);
  assert.deepEqual(await getReview("run", "T01", 1, options), next);
  assert.deepEqual(
    await readFile(
      path.join(options.projectRoot, "results/run/T01/1/result.json"),
    ),
    original,
  );
});
test("simultaneous edits serialize with one revision conflict and no lost update", async (t) => {
  const options = await fixture(t);
  const blank = await getReview("run", "T01", 1, options);
  const edits = await Promise.allSettled([
    saveReview("run", "T01", 1, reviewInput(blank.evidenceDigest), options),
    saveReview(
      "run",
      "T01",
      1,
      { ...reviewInput(blank.evidenceDigest), note: "second" },
      options,
    ),
  ]);
  assert.equal(edits.filter((e) => e.status === "fulfilled").length, 1);
  const rejected = edits.find((e) => e.status === "rejected");
  assert.ok(rejected?.status === "rejected" && status(409)(rejected.reason));
  assert.equal((await getReview("run", "T01", 1, options)).history.length, 1);
});
test("evidence edits require explicit review of the new digest", async (t) => {
  const options = await fixture(t);
  const blank = await getReview("run", "T01", 1, options);
  await saveReview("run", "T01", 1, reviewInput(blank.evidenceDigest), options);
  await writeFile(
    path.join(options.projectRoot, "results/run/T01/1/result.json"),
    JSON.stringify({ ...record, passed: true }),
  );
  const stale = await getReview("run", "T01", 1, options);
  assert.equal(stale.stale, true);
  assert.notEqual(stale.currentEvidenceDigest, stale.evidenceDigest);
  await assert.rejects(
    saveReview("run", "T01", 1, reviewInput(blank.evidenceDigest, 1), options),
    status(409),
  );
  const refreshed = await saveReview(
    "run",
    "T01",
    1,
    reviewInput(stale.currentEvidenceDigest, 1),
    options,
  );
  assert.equal(refreshed.stale, false);
  assert.equal(refreshed.history.length, 2);
});
test("task snapshot changes and run folder aliases have separate review identity", async (t) => {
  const options = await fixture(t);
  const blank = await getReview("run", "T01", 1, options);
  await saveReview("run", "T01", 1, reviewInput(blank.evidenceDigest), options);
  await saveRun(options.projectRoot, "recovered", "original-uuid");
  assert.equal((await getReview("recovered", "T01", 1, options)).revision, 0);
  await writeFile(
    path.join(options.projectRoot, "results/run/T01/1/task.json"),
    JSON.stringify({ definition: { id: "T01", name: "Changed" } }),
  );
  assert.equal((await getReview("run", "T01", 1, options)).stale, true);
});
test("corrupt review file refuses read and write without resetting history", async (t) => {
  const options = await fixture(t);
  const blank = await getReview("run", "T01", 1, options);
  await saveReview("run", "T01", 1, reviewInput(blank.evidenceDigest), options);
  const workspace = path.join(options.projectRoot, ".gauntlet-workspace");
  const name = (await readdir(workspace)).find((n) => n.startsWith("review-"))!;
  await writeFile(path.join(workspace, name), "{broken");
  await assert.rejects(getReview("run", "T01", 1, options), status(503));
  await assert.rejects(
    saveReview("run", "T01", 1, reviewInput(blank.evidenceDigest), options),
    status(503),
  );
  assert.equal(await readFile(path.join(workspace, name), "utf8"), "{broken");
});
test("symlink workspace folders and special metadata files are refused", async (t) => {
  const options = await fixture(t);
  const workspace = path.join(options.projectRoot, ".gauntlet-workspace");
  const target = path.join(options.projectRoot, "other");
  await mkdir(target);
  await symlink(target, workspace);
  await assert.rejects(listPresets(options), status(503));
  await assert.rejects(
    savePreset({ revision: 0, name: "Smoke", setup }, options),
    status(503),
  );
  await rm(workspace);
  await mkdir(workspace);
  await writeFile(path.join(target, "outside"), "untouched");
  await symlink(
    path.join(target, "outside"),
    path.join(workspace, "presets.json"),
  );
  await assert.rejects(
    savePreset({ revision: 0, name: "Smoke", setup }, options),
    status(503),
  );
  assert.equal(
    await readFile(path.join(target, "outside"), "utf8"),
    "untouched",
  );
  await rm(path.join(workspace, "presets.json"));
  execFileSync("mkfifo", [path.join(workspace, "presets.json")]);
  await assert.rejects(listPresets(options), status(503));
});
test("abandoned lock is bounded, actionable, and never stolen", async (t) => {
  const options = await fixture(t);
  const workspace = path.join(options.projectRoot, ".gauntlet-workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, ".write.lock"), "old lock");
  await assert.rejects(
    savePreset(
      { revision: 0, name: "Smoke", setup },
      { ...options, lockTimeoutMs: 5 },
    ),
    /all writers have stopped/,
  );
  assert.equal(
    await readFile(path.join(workspace, ".write.lock"), "utf8"),
    "old lock",
  );
});
test("saved presets roundtrip, validate setup, retain revisions, and reject conflicts", async (t) => {
  const options = await fixture(t);
  const saved = await savePreset(
    { revision: 0, name: " Smoke ", setup },
    options,
  );
  assert.equal(saved.name, "Smoke");
  assert.equal(saved.revision, 1);
  const updated = await savePreset(
    {
      id: saved.id,
      revision: 1,
      name: "Larger",
      setup: { ...setup, trials: 2 },
    },
    options,
  );
  assert.deepEqual((await listPresets(options))[0], updated);
  assert.equal(updated.history[0].setup.trials, 1);
  await assert.rejects(
    savePreset({ id: saved.id, revision: 1, name: "Stale", setup }, options),
    status(409),
  );
  await assert.rejects(
    savePreset(
      { revision: 0, name: "Invalid", setup: { ...setup, tasks: ["T99"] } },
      options,
    ),
  );
  await assert.rejects(
    savePreset({ revision: 0, name: "x".repeat(81), setup }, options),
  );
});
test("preset corruption and nonsequential history are never overwritten", async (t) => {
  const options = await fixture(t);
  await savePreset({ revision: 0, name: "Smoke", setup }, options);
  const file = path.join(
    options.projectRoot,
    ".gauntlet-workspace/presets.json",
  );
  const data = JSON.parse(await readFile(file, "utf8"));
  data.presets[0].history[0].revision = 2;
  await writeFile(file, JSON.stringify(data));
  await assert.rejects(listPresets(options), /history is inconsistent/);
  await assert.rejects(
    savePreset({ revision: 0, name: "Second", setup }, options),
    status(503),
  );
  assert.equal(JSON.parse(await readFile(file, "utf8")).presets.length, 1);
});
test("missing evidence and invalid review input preserve browse-only fallback", async (t) => {
  const options = await fixture(t);
  const blank = await getReview("run", "T01", 1, options);
  await assert.rejects(
    saveReview(
      "run",
      "T01",
      1,
      { ...reviewInput(blank.evidenceDigest), note: "x".repeat(8001) },
      options,
    ),
  );
  await assert.rejects(getReview("../run", "T01", 1, options));
  await assert.rejects(getReview("run", "T01", 2, options), status(404));
  await rm(path.join(options.projectRoot, "results/run/T01/1/task.json"));
  await assert.rejects(getReview("run", "T01", 1, options), /audit the run/);
});
test("attempt links are durable, idempotent, alias-safe and cycle-safe", async (t) => {
  const options = await fixture(t);
  await saveRun(options.projectRoot, "retry", "new-uuid");
  await saveRun(options.projectRoot, "recovered", "original-uuid");
  const link = await recordAttempt("run", "retry", options);
  assert.deepEqual(await recordAttempt("run", "retry", options), link);
  assert.deepEqual(await getAttempts("run", options), {
    parents: [],
    children: [link],
  });
  assert.deepEqual(await getAttempts("retry", options), {
    parents: [link],
    children: [],
  });
  await assert.rejects(recordAttempt("run", "run", options), status(409));
  await assert.rejects(recordAttempt("run", "recovered", options), status(409));
  await assert.rejects(recordAttempt("retry", "run", options), /cycle/);
  await assert.rejects(
    recordAttempt("recovered", "retry", options),
    /already linked/,
  );
  await assert.rejects(recordAttempt("run", "missing", options), status(404));
});
test("replaced run directories do not inherit earlier attempt history", async (t) => {
  const options = await fixture(t);
  await saveRun(options.projectRoot, "retry", "new-uuid");
  await recordAttempt("run", "retry", options);
  await saveRun(options.projectRoot, "retry", "replacement-uuid");
  assert.deepEqual(await getAttempts("retry", options), {
    parents: [],
    children: [],
  });
  await assert.rejects(recordAttempt("run", "retry", options), status(409));
});

test("history and collection bounds refuse writes without truncating prior versions", async (t) => {
  const options = await fixture(t);
  const preset = await savePreset(
    { revision: 0, name: "Smoke", setup },
    options,
  );
  const file = path.join(
    options.projectRoot,
    ".gauntlet-workspace/presets.json",
  );
  const data = JSON.parse(await readFile(file, "utf8"));
  data.presets[0].history = Array.from({ length: 100 }, (_, i) => ({
    ...preset.history[0],
    revision: i + 1,
  }));
  await writeFile(file, JSON.stringify(data));
  await assert.rejects(
    savePreset(
      { id: preset.id, revision: 100, name: "Too many", setup },
      options,
    ),
    /100 revisions/,
  );
  assert.equal((await listPresets(options))[0].history.length, 100);
  const blank = await getReview("run", "T01", 1, options);
  await saveReview("run", "T01", 1, reviewInput(blank.evidenceDigest), options);
  const workspace = path.join(options.projectRoot, ".gauntlet-workspace");
  const reviewFile = path.join(
    workspace,
    (await readdir(workspace)).find((n) => n.startsWith("review-"))!,
  );
  const reviewData = JSON.parse(await readFile(reviewFile, "utf8"));
  reviewData.history = Array.from({ length: 100 }, (_, i) => ({
    ...reviewData.history[0],
    revision: i + 1,
  }));
  await writeFile(reviewFile, JSON.stringify(reviewData));
  await assert.rejects(
    saveReview(
      "run",
      "T01",
      1,
      reviewInput(blank.evidenceDigest, 100),
      options,
    ),
    /100 revisions/,
  );
  assert.equal((await getReview("run", "T01", 1, options)).history.length, 100);
});

test("replaced run identity makes earlier review stale even with identical trial bytes", async (t) => {
  const options = await fixture(t);
  const blank = await getReview("run", "T01", 1, options);
  await saveReview("run", "T01", 1, reviewInput(blank.evidenceDigest), options);
  await saveRun(options.projectRoot, "run", "replacement-uuid");
  assert.equal((await getReview("run", "T01", 1, options)).stale, true);
});
