import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createCloudArtifacts,
  type ArtifactStorage,
} from "../lib/cloud-artifacts";
import { StoreError } from "../lib/store";

function fixture() {
  const objects = new Map<string, { bytes: Buffer; etag: string }>();
  let version = 0;
  let conflicts = 0;
  const deps: ArtifactStorage = {
    async readJSON<T>(key: string) {
      const row = objects.get(key);
      return row
        ? { value: JSON.parse(row.bytes.toString()) as T, etag: row.etag }
        : null;
    },
    async writeJSON(key, value, expected) {
      if (conflicts > 0) {
        conflicts--;
        throw new StoreError("conflict", 409);
      }
      if ((objects.get(key)?.etag ?? null) !== expected)
        throw new StoreError("conflict", 409);
      const etag = String(++version);
      objects.set(key, { bytes: Buffer.from(JSON.stringify(value)), etag });
      return { etag };
    },
    async readBytes(key, limit) {
      const row = objects.get(key);
      if (!row) throw new StoreError("missing", 404);
      if (row.bytes.length > limit) throw new StoreError("too large", 413);
      return Buffer.from(row.bytes);
    },
    async writeBytes(key, bytes) {
      if (objects.has(key)) throw new StoreError("conflict", 409);
      const etag = String(++version);
      objects.set(key, { bytes: Buffer.from(bytes), etag });
      return { etag };
    },
    async listKeys(prefix, limit = 200) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      return { keys: keys.slice(0, limit), truncated: keys.length > limit };
    },
  };
  return {
    cloud: createCloudArtifacts(deps),
    deps,
    objects,
    conflict: (count: number) => {
      conflicts = count;
    },
  };
}
const status = (code: number) => (error: unknown) =>
  error instanceof StoreError && error.status === code;
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
const manifest = {
  schema_version: 2,
  run_id: "original",
  created_at: "2026-09-21T00:00:00Z",
  mode: "dry-run",
  model: "dry-run",
  status: "complete",
  planned_trials: 1,
  trials_per_task: 1,
  task_ids: ["T01"],
  records: [record],
};
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

test("artifacts round-trip through content hashes and canonical run paths", async () => {
  const { cloud, objects } = fixture();
  const bytes = json(manifest);
  await cloud.ingestArtifact("run", "results.json", bytes);
  await cloud.ingestArtifact("run", "results.json", bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.ok(objects.has(`artifacts/run/${hash}`));
  assert.deepEqual(await cloud.readCloudArtifact("run", "results.json"), bytes);
  assert.equal((await cloud.readCloudRun("run")).run_id, "original");
  const library = await cloud.listCloudRuns();
  assert.equal(library.source, "cloud");
  assert.equal(library.runs[0].recorded, 1);
});

test("invalid run identities and artifact paths never write objects", async () => {
  const { cloud, objects } = fixture();
  for (const id of ["../escape", "a/b", ".hidden", "https://remote"]) {
    await assert.rejects(
      cloud.ingestArtifact(id, "results.json", json({})),
      status(400),
    );
    await assert.rejects(
      cloud.withEvidenceProject([id], async () => {}),
      status(400),
    );
  }
  for (const name of [
    "../results.json",
    "T01/0/task.json",
    "T01/01/task.json",
    "T01/1/../../x",
    "secret.env",
    "T01/1/final.png",
  ]) {
    await assert.rejects(
      cloud.ingestArtifact("run", name, json({})),
      status(400),
    );
  }
  await assert.rejects(
    cloud.ingestArtifact(
      "run",
      "results.json",
      Buffer.alloc(3 * 1024 * 1024 + 1),
    ),
    status(413),
  );
  assert.equal(objects.size, 0);
});

test("checksum mismatches and foreign artifact identities fail closed", async () => {
  const { cloud, objects } = fixture();
  await cloud.ingestArtifact("run", "results.json", json(manifest));
  const index = await cloud.artifactIndex("run");
  const file = index.value.files["results.json"];
  objects.get(file.key)!.bytes = Buffer.from("damaged");
  await assert.rejects(
    cloud.readCloudArtifact("run", "results.json"),
    status(503),
  );
  file.key = file.key.replace("/run/", "/foreign/");
  objects.get("indexes/run.json")!.bytes = json(index.value);
  await assert.rejects(cloud.artifactIndex("run"), status(503));
  await assert.rejects(
    cloud.ingestArtifact("run", "T01/1/result.json", json(record)),
    status(503),
  );
});

test("index updates retry bounded CAS conflicts without losing existing paths", async () => {
  const { cloud, conflict } = fixture();
  await cloud.ingestArtifact("run", "results.json", json(manifest));
  conflict(2);
  await cloud.ingestArtifact("run", "T01/1/result.json", json(record));
  assert.equal(
    Object.keys((await cloud.artifactIndex("run")).value.files).length,
    2,
  );
  conflict(4);
  await assert.rejects(
    cloud.ingestArtifact("run", "T01/1/task.json", json({})),
    status(409),
  );
  assert.equal(
    Object.keys((await cloud.artifactIndex("run")).value.files).length,
    2,
  );
});

test("assessment evidence excludes images and actions and temporary projects are removed", async () => {
  const { cloud } = fixture();
  for (const [name, bytes] of [
    ["results.json", json(manifest)],
    ["T01/1/result.json", json(record)],
    ["T01/1/task.json", json({ definition: { id: "T01" } })],
    ["T01/1/lifecycle.jsonl", Buffer.from("{}\n")],
    ["T01/1/actions.jsonl", Buffer.from("{}\n")],
    ["T01/1/final.jpg", Buffer.from([255, 216])],
  ] as const)
    await cloud.ingestArtifact("run", name, bytes);
  assert.deepEqual(
    (await cloud.getCloudEvidenceFiles("run")).map((file) => file.path).sort(),
    [
      "T01/1/lifecycle.jsonl",
      "T01/1/result.json",
      "T01/1/task.json",
      "results.json",
    ],
  );
  let savedRoot = "";
  await cloud.withEvidenceProject(
    ["run"],
    async (root) => {
      savedRoot = root;
      assert.deepEqual(
        JSON.parse(
          await readFile(
            path.join(root, "results/run/T01/1/result.json"),
            "utf8",
          ),
        ),
        record,
      );
    },
    true,
  );
  await assert.rejects(access(savedRoot));
  await assert.rejects(
    cloud.withEvidenceProject(["run"], async (root) => {
      savedRoot = root;
      throw new Error("callback");
    }),
    /callback/,
  );
  await assert.rejects(access(savedRoot));
});

test("missing action history retains saved trial and image evidence", async () => {
  const { cloud } = fixture();
  await cloud.ingestArtifact("run", "results.json", json(manifest));
  await cloud.ingestArtifact("run", "T01/1/final.jpg", Buffer.from([255, 216]));
  const trial = await cloud.readCloudTrial("run", "T01", 1);
  assert.equal(trial.trial.passed, false);
  assert.equal(trial.warnings.length, 1);
  assert.deepEqual(trial.screenshots, ["final.jpg"]);
  await assert.rejects(cloud.readCloudTrial("run", "T02", 1), status(404));
  await cloud.ingestArtifact("broken", "results.json", json({}));
  const library = await cloud.listCloudRuns();
  assert.equal(library.runs.length, 1);
  assert.equal(library.warnings.length, 1);
});

test("evidence collection limits are checked before downloading payloads", async () => {
  const { cloud, deps } = fixture();
  const sha256 = "a".repeat(64);
  const file = {
    key: `artifacts/run/${sha256}`,
    sha256,
    size: 3 * 1024 * 1024,
  };
  const files: Record<string, typeof file> = { "results.json": file };
  for (let i = 1; i < 45; i++) files[`T01/${i}/result.json`] = file;
  await deps.writeJSON(
    "indexes/run.json",
    { version: 1, files, updatedAt: "now" },
    null,
  );
  await assert.rejects(cloud.getCloudEvidenceFiles("run"), status(413));
});
