import test from "node:test";
import assert from "node:assert/strict";
import { createIngestHandler } from "../lib/cloud-ingest";
import type { CloudJob } from "../lib/cloud-runner";

function fixture(options: { missing?: boolean; linkFailure?: boolean } = {}) {
  let job: CloudJob = {
    id: `cloud_${"a".repeat(32)}`,
    callbackToken: "b".repeat(64),
    mode: "dry-run",
    setup: {
      tasks: ["T01"],
      trials: 1,
      concurrency: 1,
      maxInfraFailures: 1,
      provider: "claude",
      modelId: "",
    },
    status: "running",
    sourceRevision: "c".repeat(40),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sandboxId: "sandbox-one",
  };
  const artifacts: { name: string; bytes: Buffer }[] = [];
  const stopped: string[] = [];
  const handler = createIngestHandler({
    getJob: async () => structuredClone(job),
    updateJob: async (_id, change) => (job = change(job)),
    ingest: async (_id, name, bytes) => {
      artifacts.push({ name, bytes });
    },
    readRun: async () => {
      if (options.missing) throw new Error("missing");
      return {} as never;
    },
    linkAttempt: async () => {
      if (options.linkFailure) throw new Error("conflict");
      return {} as never;
    },
    scheduleStop: (name) => stopped.push(name),
  });
  const send = (payload: Record<string, unknown>, token = job.callbackToken) =>
    handler(
      new Request("https://app.example.com/api/cloud/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: job.id, token, ...payload }),
      }),
    );
  return {
    send,
    artifacts,
    stopped,
    job: () => job,
    setJob: (patch: Partial<CloudJob>) => {
      job = { ...job, ...patch };
    },
  };
}
const file = (name = "T01/1/actions.jsonl", content = "{}\n") => ({
  path: name,
  contentBase64: Buffer.from(content).toString("base64"),
});

test("ingestion authenticates the per-job token independently of browser cookies", async () => {
  const f = fixture();
  assert.equal((await f.send(file(), "d".repeat(64))).status, 403);
  assert.equal(f.artifacts.length, 0);
  assert.equal((await f.send(file())).status, 200);
  assert.equal(f.artifacts[0].bytes.toString(), "{}\n");
});

test("ingestion rejects path traversal, unknown slots, invalid encoding and excess fields", async () => {
  const f = fixture();
  for (const payload of [
    file("../results.json"),
    file("T02/1/result.json"),
    file("T01/2/result.json"),
    { ...file(), contentBase64: "invalid!" },
    { ...file(), extra: true },
  ]) {
    assert.equal((await f.send(payload)).status, 400);
  }
  assert.equal(f.artifacts.length, 0);
});

test("manifest must match the original execution plan", async () => {
  const f = fixture();
  const manifest = {
    mode: "live",
    task_ids: ["T01"],
    trials_per_task: 1,
    planned_trials: 1,
  };
  assert.equal(
    (await f.send(file("results.json", JSON.stringify(manifest)))).status,
    400,
  );
  manifest.mode = "dry-run";
  assert.equal(
    (await f.send(file("results.json", JSON.stringify(manifest)))).status,
    200,
  );
});

test("terminal completion is idempotent and does not allow later artifact changes", async () => {
  const f = fixture();
  assert.equal((await f.send({ complete: true, exitCode: 3 })).status, 200);
  assert.equal(f.job().status, "complete");
  assert.deepEqual(f.stopped, ["sandbox-one"]);
  assert.equal(
    (await f.send({ complete: true, exitCode: 2, error: "late failure" }))
      .status,
    200,
  );
  assert.equal(f.job().status, "complete");
  assert.equal(f.job().exitCode, 3);
  assert.equal((await f.send(file())).status, 409);
});

test("completion records infrastructure failures, missing manifests and linking failures", async () => {
  for (const options of [{}, { missing: true }, { linkFailure: true }]) {
    const f = fixture(options);
    f.setJob({ parentId: "parent" });
    const exitCode = Object.keys(options).length ? 0 : 2;
    assert.equal((await f.send({ complete: true, exitCode })).status, 200);
    assert.equal(f.job().status, "failed");
    if (exitCode === 0) assert.ok(f.job().error);
    assert.deepEqual(f.stopped, ["sandbox-one"]);
  }
});

test("expired jobs reject updates while timely ambiguous launches may resolve", async () => {
  const f = fixture();
  f.setJob({ expiresAt: new Date(0).toISOString() });
  assert.equal((await f.send(file())).status, 410);
  assert.equal((await f.send({ complete: true, exitCode: 0 })).status, 410);
  f.setJob({
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "interrupted",
  });
  assert.equal((await f.send({ complete: true, exitCode: 0 })).status, 200);
  assert.equal(f.job().status, "complete");
});

test("body and decoded artifact sizes are bounded", async () => {
  const f = fixture();
  assert.equal(
    (await f.send(file("T01/1/001.jpg", "a".repeat(2 * 1024 * 1024)))).status,
    200,
  );
  assert.equal(
    (await f.send(file("T01/1/001.jpg", "a".repeat(2 * 1024 * 1024 + 1))))
      .status,
    413,
  );
  assert.equal(
    (await f.send(file("T01/1/001.jpg", "a".repeat(3 * 1024 * 1024)))).status,
    413,
  );
});
