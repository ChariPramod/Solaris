import test from "node:test";
import assert from "node:assert/strict";
import {
  createCloudArtifacts,
  type ArtifactStorage,
} from "../lib/cloud-artifacts";
import { createCloudWorkspaceData } from "../lib/cloud-workspace-data";
import { StoreError } from "../lib/store";

function fixture() {
  const data = new Map<string, { bytes: Buffer; etag: string }>();
  let revision = 0;
  let reads = 0;
  const storage: ArtifactStorage = {
    async readJSON<T>(key: string) {
      reads++;
      const row = data.get(key);
      return row
        ? { value: JSON.parse(row.bytes.toString()) as T, etag: row.etag }
        : null;
    },
    async writeJSON(key, value, expected) {
      if ((data.get(key)?.etag ?? null) !== expected)
        throw new StoreError("Save conflict", 409);
      const etag = String(++revision);
      data.set(key, { bytes: Buffer.from(JSON.stringify(value)), etag });
      return { etag };
    },
    async writeBytes(key, bytes) {
      if (data.has(key)) throw new StoreError("Already exists", 409);
      const etag = String(++revision);
      data.set(key, { bytes: Buffer.from(bytes), etag });
      return { etag };
    },
    async readBytes(key, limit) {
      const bytes = data.get(key)?.bytes;
      if (!bytes) throw new StoreError("Missing", 404);
      if (bytes.length > limit) throw new StoreError("Oversize", 413);
      return Buffer.from(bytes);
    },
    async listKeys(prefix, limit = 200) {
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix));
      return { keys: keys.slice(0, limit), truncated: keys.length > limit };
    },
  };
  const artifacts = createCloudArtifacts(storage);
  return {
    workspace: createCloudWorkspaceData(storage, artifacts),
    artifacts,
    storage,
    data,
    reads: () => reads,
  };
}
const status = (code: number) => (error: unknown) =>
  error instanceof StoreError && error.status === code;
const setup = {
  tasks: ["T01"],
  trials: 1,
  concurrency: 1,
  maxInfraFailures: 1,
  provider: "claude",
  modelId: "",
};
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
async function saveRun(
  artifacts: ReturnType<typeof createCloudArtifacts>,
  id: string,
  uuid = id,
) {
  const manifest = {
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
  };
  for (const [name, value] of [
    ["results.json", manifest],
    ["T01/1/result.json", record],
    [
      "T01/1/task.json",
      { definition: { id: "T01", name: "Example" }, sha256: "example" },
    ],
  ] as const) {
    await artifacts.ingestArtifact(
      id,
      name,
      Buffer.from(JSON.stringify(value)),
    );
  }
}

test("cloud presets persist across service instances without changing local rules", async () => {
  const { workspace, storage, artifacts, data } = fixture();
  assert.deepEqual(await workspace.listPresets(), []);
  assert.equal(data.size, 0);
  const saved = await workspace.savePreset({
    revision: 0,
    name: "Smoke test",
    setup,
  });
  const fresh = createCloudWorkspaceData(storage, artifacts);
  assert.equal((await fresh.listPresets())[0].id, saved.id);
  await fresh.savePreset({ id: saved.id, revision: 1, name: "Updated", setup });
  await assert.rejects(
    workspace.savePreset({ id: saved.id, revision: 1, name: "Stale", setup }),
    status(409),
  );
  const latest = (await fresh.listPresets())[0];
  assert.equal(latest.name, "Updated");
  assert.equal(latest.history.length, 2);
});

test("simultaneous cloud saves cannot silently discard a competing preset", async () => {
  const { workspace } = fixture();
  const outcomes = await Promise.allSettled([
    workspace.savePreset({ revision: 0, name: "First", setup }),
    workspace.savePreset({ revision: 0, name: "Second", setup }),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failure = outcomes.find((result) => result.status === "rejected");
  assert.ok(failure?.status === "rejected");
  assert.ok(status(409)(failure.reason));
  assert.equal((await workspace.listPresets()).length, 1);
});

test("cloud review files preserve history and bind to original trial evidence", async () => {
  const { workspace, artifacts, storage } = fixture();
  await saveRun(artifacts, "run");
  const original = await artifacts.readCloudArtifact(
    "run",
    "T01/1/result.json",
  );
  const blank = await workspace.getReview("run", "T01", 1);
  const input = {
    revision: 0,
    evidenceDigest: blank.evidenceDigest,
    verdict: "needs-investigation",
    category: "agent",
    note: "Check click",
    reviewer: "Reviewer",
  };
  const saved = await workspace.saveReview("run", "T01", 1, input);
  assert.equal(saved.revision, 1);
  assert.equal(
    (await workspace.getReview("run", "T01", 1)).note,
    "Check click",
  );
  const document = await storage.readJSON<{ files: Record<string, string> }>(
    "workspace/metadata.json",
  );
  assert.match(
    Object.keys(document!.value.files)[0],
    /^review-[a-f0-9]{64}\.json$/,
  );
  assert.deepEqual(
    await artifacts.readCloudArtifact("run", "T01/1/result.json"),
    original,
  );
  await artifacts.ingestArtifact(
    "run",
    "T01/1/result.json",
    Buffer.from(JSON.stringify({ ...record, steps: 2 })),
  );
  assert.equal((await workspace.getReview("run", "T01", 1)).stale, true);
  await assert.rejects(
    workspace.saveReview("run", "T01", 1, { ...input, revision: 1 }),
    status(409),
  );
});

test("cloud attempt history enforces distinct identities and persists relationships", async () => {
  const { workspace, artifacts } = fixture();
  await saveRun(artifacts, "parent");
  await saveRun(artifacts, "child");
  await saveRun(artifacts, "recovered", "parent");
  await assert.rejects(
    workspace.recordAttempt("parent", "recovered"),
    status(409),
  );
  await workspace.recordAttempt("parent", "child");
  assert.equal(
    (await workspace.getAttempts("parent")).children[0].childId,
    "child",
  );
  assert.equal(
    (await workspace.getAttempts("child")).parents[0].parentId,
    "parent",
  );
  await assert.rejects(workspace.recordAttempt("child", "parent"), status(409));
});

test("invalid run IDs fail before metadata reads or materialization", async () => {
  const { workspace, reads } = fixture();
  await assert.rejects(
    workspace.getReview("../outside", "T01", 1),
    status(400),
  );
  await assert.rejects(
    workspace.recordAttempt("safe", "../outside"),
    status(400),
  );
  assert.equal(reads(), 0);
});

test("corrupt metadata and unexpected filenames cannot be reset by saving", async () => {
  for (const files of [
    { "../outside.json": "{}" },
    { "unknown.json": "{}" },
    { "presets.json": "not json" },
  ]) {
    const { workspace, storage, data } = fixture();
    await storage.writeJSON(
      "workspace/metadata.json",
      { version: 1, files },
      null,
    );
    const original = Buffer.from(data.get("workspace/metadata.json")!.bytes);
    await assert.rejects(
      workspace.savePreset({ revision: 0, name: "New", setup }),
      status(503),
    );
    assert.deepEqual(data.get("workspace/metadata.json")!.bytes, original);
  }
});
