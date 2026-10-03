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
  const operations = {
    readJSON: 0,
    writeJSON: 0,
    readBytes: 0,
    writeBytes: 0,
    listKeys: 0,
  };
  const deps: ArtifactStorage = {
    async readJSON<T>(key: string) {
      operations.readJSON++;
      const row = objects.get(key);
      return row
        ? { value: JSON.parse(row.bytes.toString()) as T, etag: row.etag }
        : null;
    },
    async writeJSON(key, value, expected) {
      operations.writeJSON++;
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
      operations.readBytes++;
      const row = objects.get(key);
      if (!row) throw new StoreError("missing", 404);
      if (row.bytes.length > limit) throw new StoreError("too large", 413);
      return Buffer.from(row.bytes);
    },
    async writeBytes(key, bytes) {
      operations.writeBytes++;
      if (objects.has(key)) throw new StoreError("conflict", 409);
      const etag = String(++version);
      objects.set(key, { bytes: Buffer.from(bytes), etag });
      return { etag };
    },
    async listKeys(prefix, limit = 200) {
      operations.listKeys++;
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      return { keys: keys.slice(0, limit), truncated: keys.length > limit };
    },
  };
  return {
    cloud: createCloudArtifacts(deps),
    deps,
    objects,
    operations,
    resetOperations: () => {
      for (const key of Object.keys(operations) as Array<
        keyof typeof operations
      >)
        operations[key] = 0;
    },
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

test("manifest snapshots read one verified body and recheck only the relevant pointer", async () => {
  const f = fixture();
  await f.cloud.ingestArtifact("run", "results.json", json(manifest));
  f.resetOperations();
  const result = await f.cloud.readCloudRunSnapshot("run");
  assert.equal(result.run.id, "run");
  assert.equal(
    result.manifestSha256,
    createHash("sha256").update(json(manifest)).digest("hex"),
  );
  assert.equal(f.operations.readJSON, 2);
  assert.equal(f.operations.readBytes, 1);
  assert.equal(f.operations.writeBytes + f.operations.writeJSON, 0);

  const originalRead = f.deps.readBytes;
  const unrelated = createCloudArtifacts({
    ...f.deps,
    async readBytes(key, limit) {
      const bytes = await originalRead(key, limit);
      await f.cloud.ingestArtifact(
        "run",
        "T01/1/final.jpg",
        Buffer.from("image"),
      );
      return bytes;
    },
  });
  assert.equal(
    (await unrelated.readCloudRunSnapshot("run")).manifestSha256,
    result.manifestSha256,
  );
});

test("manifest snapshots refuse a changed pointer and corrupt immutable bytes", async () => {
  const f = fixture();
  await f.cloud.ingestArtifact("run", "results.json", json(manifest));
  const originalRead = f.deps.readBytes;
  const racing = createCloudArtifacts({
    ...f.deps,
    async readBytes(key, limit) {
      const bytes = await originalRead(key, limit);
      await f.cloud.ingestArtifact(
        "run",
        "results.json",
        json({ ...manifest, status: "interrupted" }),
      );
      return bytes;
    },
  });
  await assert.rejects(racing.readCloudRunSnapshot("run"), status(409));
  const index = await f.cloud.artifactIndex("run");
  f.objects.get(index.value.files["results.json"].key)!.bytes =
    Buffer.from("broken");
  await assert.rejects(f.cloud.readCloudRunSnapshot("run"), status(503));
});

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

test("summary listing reads one index per run and no artifact bodies", async () => {
  const { cloud, operations, resetOperations } = fixture();
  await cloud.ingestArtifact("first", "results.json", json(manifest));
  await cloud.ingestArtifact("second", "results.json", json(manifest));
  resetOperations();
  const library = await cloud.listCloudRuns();
  assert.equal(library.runs.length, 2);
  assert.deepEqual(library.warnings, []);
  assert.deepEqual(operations, {
    readJSON: 2,
    writeJSON: 0,
    readBytes: 0,
    writeBytes: 0,
    listKeys: 1,
  });
});

test("legacy and malformed summaries fall back to verified evidence without warnings", async () => {
  const { cloud, objects, operations, resetOperations } = fixture();
  await cloud.ingestArtifact("run", "results.json", json(manifest));
  const index = (await cloud.artifactIndex("run")).value;
  const valid = index.runSummary as {
    version: number;
    manifestSha256: string;
    run: Record<string, unknown>;
  };
  const invalid = [
    undefined,
    null,
    {},
    { ...valid, version: 2 },
    { ...valid, manifestSha256: "a".repeat(64) },
    { ...valid, run: { ...valid.run, id: "another-run" } },
    { ...valid, run: { ...valid.run, recorded: 100 } },
    { ...valid, run: { ...valid.run, passed: 2 } },
    { ...valid, run: { ...valid.run, planned_trials: 2 } },
    { ...valid, run: { ...valid.run, records: [] } },
  ];
  for (const runSummary of invalid) {
    objects.get("indexes/run.json")!.bytes = json({ ...index, runSummary });
    resetOperations();
    const library = await cloud.listCloudRuns();
    assert.equal(library.runs[0].recorded, 1);
    assert.deepEqual(library.warnings, []);
    assert.equal(operations.readJSON, 1);
    assert.equal(operations.readBytes, 1);
    assert.equal(operations.writeJSON, 0);
  }
  const entry = index.files["results.json"];
  objects.get(entry.key)!.bytes = Buffer.from("corrupt evidence");
  const library = await cloud.listCloudRuns();
  assert.equal(library.runs.length, 0);
  assert.equal(library.warnings.length, 1);
});

test("summary replacement follows the manifest CAS and invalid manifests drop old summaries", async () => {
  const { cloud } = fixture();
  await cloud.ingestArtifact("run", "results.json", json(manifest));
  await Promise.all([
    cloud.ingestArtifact(
      "run",
      "results.json",
      json({ ...manifest, status: "stopped" }),
    ),
    cloud.ingestArtifact("run", "T01/1/result.json", json(record)),
  ]);
  const index = await cloud.artifactIndex("run");
  const summary = index.value.runSummary as {
    manifestSha256: string;
    run: { status: string };
  };
  assert.equal(
    summary.manifestSha256,
    index.value.files["results.json"].sha256,
  );
  assert.equal(summary.run.status, "stopped");
  assert.ok(index.value.files["T01/1/result.json"]);
  assert.equal((await cloud.listCloudRuns()).runs[0].status, "stopped");
  await cloud.ingestArtifact("run", "results.json", json({}));
  assert.equal((await cloud.artifactIndex("run")).value.runSummary, undefined);
  assert.equal((await cloud.listCloudRuns()).runs.length, 0);
});

test("unchanged uploads read once and write neither immutable bytes nor the index", async () => {
  const { cloud, operations, resetOperations, objects } = fixture();
  const bytes = json(manifest);
  await cloud.ingestArtifact("run", "results.json", bytes);
  const etag = objects.get("indexes/run.json")!.etag;
  resetOperations();
  await cloud.ingestArtifact("run", "results.json", bytes);
  assert.equal(objects.get("indexes/run.json")!.etag, etag);
  assert.deepEqual(operations, {
    readJSON: 1,
    writeJSON: 0,
    readBytes: 0,
    writeBytes: 0,
    listKeys: 0,
  });
});

test("concurrent identical uploads converge without rewriting the winning index", async () => {
  const { cloud, operations } = fixture();
  await Promise.all([
    cloud.ingestArtifact("run", "results.json", json(manifest)),
    cloud.ingestArtifact("run", "results.json", json(manifest)),
  ]);
  assert.equal(operations.writeJSON, 2); // One success, one stale CAS.
  assert.equal(operations.readJSON, 3); // Loser checks the winner, then returns.
  assert.equal((await cloud.readCloudRun("run")).run_id, "original");
});

test("trial details read one index snapshot for manifest, actions and screenshot names", async () => {
  const { cloud, deps, operations, resetOperations } = fixture();
  await cloud.ingestArtifact("run", "results.json", json(manifest));
  await cloud.ingestArtifact(
    "run",
    "T01/1/actions.jsonl",
    Buffer.from('{"step":1,"screenshot":"001.jpg"}\n'),
  );
  await cloud.ingestArtifact("run", "T01/1/001.jpg", Buffer.from([255, 216]));
  resetOperations();
  const readJSON = deps.readJSON;
  const reader = createCloudArtifacts({
    ...deps,
    async readJSON<T>(key: string) {
      const result = await readJSON<T>(key);
      // Fail any follow-up index read instead of allowing mixed snapshots.
      if (operations.readJSON > 1) throw new Error("Index was fetched again");
      return result;
    },
  });
  const detail = await reader.readCloudTrial("run", "T01", 1);
  assert.equal(detail.frames.length, 1);
  assert.deepEqual(detail.screenshots, ["001.jpg"]);
  assert.deepEqual(detail.warnings, []);
  assert.deepEqual(operations, {
    readJSON: 1,
    writeJSON: 0,
    readBytes: 2,
    writeBytes: 0,
    listKeys: 0,
  });
});

test("paged run listings preserve provider cursors and scan only the requested page", async () => {
  const { cloud, deps, operations, resetOperations } = fixture();
  await cloud.ingestArtifact("first", "results.json", json(manifest));
  await cloud.ingestArtifact("second", "results.json", json(manifest));
  const calls: unknown[][] = [];
  const paged = createCloudArtifacts({
    ...deps,
    async listKeyPage(prefix, limit, cursor) {
      calls.push([prefix, limit, cursor]);
      return cursor
        ? { keys: ["indexes/second.json"], nextCursor: null }
        : { keys: ["indexes/first.json"], nextCursor: "provider-page-2" };
    },
  });
  resetOperations();
  const first = await paged.listCloudRuns({ limit: 1 });
  assert.deepEqual(first.page, {
    limit: 1,
    scanned: 1,
    nextCursor: "provider-page-2",
  });
  assert.deepEqual(
    first.runs.map((run) => run.id),
    ["first"],
  );
  assert.deepEqual(first.warnings, []);
  const second = await paged.listCloudRuns({
    limit: 1,
    cursor: first.page!.nextCursor!,
  });
  assert.deepEqual(second.page, { limit: 1, scanned: 1, nextCursor: null });
  assert.deepEqual(
    second.runs.map((run) => run.id),
    ["second"],
  );
  assert.deepEqual(second.warnings, []);
  assert.deepEqual(calls, [
    ["indexes/", 1, undefined],
    ["indexes/", 1, "provider-page-2"],
  ]);
  assert.equal(operations.readJSON, 2);
  assert.equal(operations.readBytes, 0);
  assert.equal(operations.listKeys, 0);
  await assert.rejects(cloud.listCloudRuns({ limit: 0 }), status(400));
});
