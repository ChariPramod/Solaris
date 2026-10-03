import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createCloudArtifacts,
  type ArtifactStorage,
} from "../lib/cloud-artifacts";
import {
  cloudExportSource,
  createEvidenceBundle,
  EXPORT_BYTES,
  localExportSource,
  scopeExportAnnotations,
  type EvidenceExportSource,
} from "../lib/evidence-export";
import { StoreError } from "../lib/store";
import { GET } from "../app/api/runs/[id]/bundle/route";
import { createSession, SESSION_COOKIE } from "../lib/cloud-auth";

const sha = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const status = (value: number) => (error: unknown) =>
  error instanceof StoreError && error.status === value;
const trial = {
  task_id: "T01",
  trial: 1,
  tier: 1,
  model: "dry-run",
  mode: "dry-run",
  passed: false,
  steps: 1,
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
  records: [trial],
};
const review = (runId = "run") => ({
  version: 1,
  runId,
  taskId: "T01",
  trial: 1,
  history: [
    {
      revision: 1,
      evidenceDigest: "a".repeat(64),
      verdict: "confirmed",
      category: "agent",
      note: "Client acceptance reviewed.",
      reviewer: "Agency QA",
      updatedAt: "2026-09-21T00:00:00Z",
    },
  ],
});
const reviewName = (id: string) =>
  `review-${sha(JSON.stringify([id, "T01", 1]))}.json`;
const link = (parentId: string, childId: string) => ({
  parentId,
  childId,
  parentRunId: `${parentId}-original`,
  childRunId: `${childId}-original`,
  createdAt: "2026-09-21T00:00:00Z",
});

async function temporary(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "solaris-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture() {
  const objects = new Map<string, { bytes: Buffer; etag: string }>();
  let version = 0;
  const deps: ArtifactStorage = {
    async readJSON<T>(key: string) {
      const found = objects.get(key);
      return found
        ? { value: JSON.parse(found.bytes.toString()) as T, etag: found.etag }
        : null;
    },
    async writeJSON(key, value) {
      const etag = String(++version);
      objects.set(key, { bytes: json(value), etag });
      return { etag };
    },
    async readBytes(key, limit) {
      const found = objects.get(key);
      if (!found) throw new StoreError("Stored file not found", 404);
      if (found.bytes.length > limit) throw new StoreError("too large", 413);
      return Buffer.from(found.bytes);
    },
    async writeBytes(key, bytes) {
      const etag = String(++version);
      objects.set(key, { bytes, etag });
      return { etag };
    },
    async listKeys(prefix) {
      return {
        keys: [...objects.keys()].filter((key) => key.startsWith(prefix)),
        truncated: false,
      };
    },
  };
  const artifacts = createCloudArtifacts(deps);
  for (const [name, bytes] of [
    ["results.json", json(manifest)],
    ["T01/1/task.json", json({ definition: { id: "T01" } })],
    ["T01/1/baseline.json", json({ existing_files: ["client-original.txt"] })],
    ["T01/1/result.json", json(trial)],
    ["T01/1/lifecycle.jsonl", Buffer.from('{"event":"closed"}\n')],
    ["T01/1/actions.jsonl", Buffer.from('{"step":1,"screenshot":"001.jpg"}\n')],
    ["T01/1/001.jpg", Buffer.from([255, 216, 1, 2])],
    ["T01/1/final.jpg", Buffer.from([255, 216, 3, 4])],
  ] as const)
    await artifacts.ingestArtifact("run", name, bytes);
  await deps.writeJSON(
    "workspace/metadata.json",
    {
      version: 1,
      files: {
        [reviewName("run")]: JSON.stringify(review()),
        [reviewName("private")]: JSON.stringify({
          ...review("private"),
          history: [
            { ...review().history[0], note: "unrelated client secret" },
          ],
        }),
        "presets.json": JSON.stringify({ private: "unrelated preset" }),
        "attempts.json": JSON.stringify({
          version: 1,
          links: [
            link("parent", "run"),
            link("run", "child"),
            link("other", "private"),
          ],
        }),
      },
    },
    null,
  );
  const job = {
    id: "run",
    status: "complete",
    mode: "dry-run",
    sourceRevision: "a".repeat(40),
    createdAt: "2026-09-21T00:00:00Z",
    updatedAt: "2026-09-21T00:01:00Z",
    callbackToken: "secret-callback-token",
    sandboxId: "private-sdk-id",
  };
  await deps.writeJSON("jobs/run.json", job, null);
  return {
    objects,
    deps,
    artifacts,
    source: cloudExportSource(artifacts, deps),
    job,
  };
}
async function unpack(t: TestContext, stream: ReadableStream<Uint8Array>) {
  const root = await temporary(t);
  const archive = Buffer.from(await new Response(stream).arrayBuffer());
  await writeFile(path.join(root, "bundle.tar.gz"), archive);
  execFileSync("tar", ["-xzf", path.join(root, "bundle.tar.gz"), "-C", root]);
  const inventory = JSON.parse(
    await readFile(path.join(root, "inventory.json"), "utf8"),
  );
  for (const entry of inventory.files) {
    assert.ok(!entry.path.startsWith("/") && !entry.path.includes(".."));
    const bytes = await readFile(path.join(root, entry.path));
    assert.equal(bytes.length, entry.size);
    assert.equal(sha(bytes), entry.sha256);
  }
  execFileSync("shasum", ["-a", "256", "-c", "checksums.sha256"], {
    cwd: root,
  });
  return { root, archive, inventory };
}

test("cloud bundle round-trips every artifact, scoped reviews and provenance with independently verifiable checksums", async (t) => {
  const { source } = await fixture();
  const bundle = await createEvidenceBundle(
    "run",
    source,
    new Date("2026-09-22T00:00:00Z"),
  );
  const { root, inventory } = await unpack(t, bundle.stream);
  assert.equal(inventory.version, 1);
  assert.equal(inventory.scope, "all-saved-run-artifacts-and-run-annotations");
  assert.equal(
    inventory.files.filter((file: { path: string }) =>
      file.path.startsWith("evidence/"),
    ).length,
    8,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(root, "evidence/results.json"), "utf8"),
    ),
    manifest,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(root, "evidence/T01/1/baseline.json"), "utf8"),
    ),
    { existing_files: ["client-original.txt"] },
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(root, `workspace/${reviewName("run")}`), "utf8"),
    ),
    review(),
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(root, "workspace/attempts.json"), "utf8"),
    ).links.length,
    2,
  );
  const provenance = await readFile(path.join(root, "provenance.json"), "utf8");
  assert.ok(
    !provenance.includes("secret-callback-token") &&
      !provenance.includes("private-sdk-id"),
  );
  assert.ok(!JSON.stringify(inventory).includes(reviewName("private")));
  const summary = await readFile(path.join(root, "HANDOFF.md"), "utf8");
  assert.match(summary, /does not measure AI model performance/);
  assert.match(summary, /1 of 1 planned/);
  assert.match(summary, /Saved human review histories: 1/);
});

test("streamed exports exceed buffered response limits without dropping screenshot evidence", async (t) => {
  const { artifacts, source } = await fixture();
  for (let i = 2; i < 5; i++)
    await artifacts.ingestArtifact(
      "run",
      `T01/1/${String(i).padStart(3, "0")}.jpg`,
      randomBytes(2 * 1024 * 1024),
    );
  const bundle = await createEvidenceBundle("run", source);
  const { archive, inventory } = await unpack(t, bundle.stream);
  assert.ok(archive.length > 4.5 * 1024 * 1024);
  assert.equal(
    inventory.files.filter((file: { path: string }) =>
      file.path.startsWith("evidence/"),
    ).length,
    11,
  );
});

test("stored null metadata is corrupt while a genuinely missing document exports empty annotations", async () => {
  const { deps, objects, source } = await fixture();
  await deps.writeJSON("workspace/metadata.json", null, null);
  await assert.rejects(createEvidenceBundle("run", source), status(503));
  objects.delete("workspace/metadata.json");
  const snapshot = await source.snapshot("run");
  assert.deepEqual(Object.keys(snapshot.annotations), [
    "workspace/attempts.json",
  ]);
  assert.deepEqual(
    JSON.parse(snapshot.annotations["workspace/attempts.json"].toString()),
    { version: 1, links: [] },
  );
});

test("missing and corrupted indexed objects fail before an archive response is created", async () => {
  const { artifacts, objects, source } = await fixture();
  const file = (await artifacts.artifactIndex("run")).value.files[
    "T01/1/001.jpg"
  ];
  objects.get(file.key)!.bytes = Buffer.from([255, 216, 8, 9]);
  await assert.rejects(createEvidenceBundle("run", source), status(503));
  objects.delete(file.key);
  await assert.rejects(createEvidenceBundle("run", source), status(404));
});

test("active jobs cannot export, but stopped partial evidence retains its incomplete status", async (t) => {
  const { source, artifacts, deps, job } = await fixture();
  await deps.writeJSON("jobs/run.json", { ...job, status: "running" }, null);
  await assert.rejects(createEvidenceBundle("run", source), status(409));
  await artifacts.ingestArtifact(
    "run",
    "results.json",
    json({
      ...manifest,
      status: "interrupted",
      planned_trials: 2,
      trials_per_task: 2,
    }),
  );
  await deps.writeJSON("jobs/run.json", { ...job, status: "cancelled" }, null);
  const { inventory, root } = await unpack(
    t,
    (await createEvidenceBundle("run", source)).stream,
  );
  assert.equal(inventory.status, "interrupted");
  assert.match(
    await readFile(path.join(root, "HANDOFF.md"), "utf8"),
    /1 of 2 planned/,
  );
});

test("concurrent artifact and scoped-review updates invalidate the snapshot", async () => {
  for (const change of ["artifact", "review"] as const) {
    const { source, artifacts, deps } = await fixture();
    let changed = false;
    const racing: EvidenceExportSource = {
      ...source,
      async read(id, entry) {
        const bytes = await source.read(id, entry);
        if (!changed) {
          changed = true;
          if (change === "artifact")
            await artifacts.ingestArtifact(
              "run",
              "T01/1/final.jpg",
              Buffer.from([255, 216, 99]),
            );
          else
            await deps.writeJSON(
              "workspace/metadata.json",
              {
                version: 1,
                files: {
                  [reviewName("run")]: JSON.stringify({
                    ...review(),
                    history: [{ ...review().history[0], note: "new review" }],
                  }),
                },
              },
              null,
            );
        }
        return bytes;
      },
    };
    await assert.rejects(createEvidenceBundle("run", racing), status(409));
  }
});

test("path, file-count, byte and per-file limits fail before reading export payloads", async () => {
  const { source } = await fixture();
  const base = await source.snapshot("run");
  for (const [entries, expected] of [
    [
      [
        { path: "results.json", size: 0 },
        { path: "../secret.env", size: 1 },
      ],
      503,
    ],
    [
      Array.from({ length: 5001 }, (_, i) => ({
        path: i ? `T01/${i}/result.json` : "results.json",
        size: 0,
      })),
      413,
    ],
    [[{ path: "results.json", size: EXPORT_BYTES + 1 }], 413],
    [
      [
        { path: "results.json", size: 0 },
        ...Array.from({ length: 5 }, (_, i) => ({
          path: `T01/${i + 1}/001.jpg`,
          size: 16 * 1024 * 1024,
        })),
      ],
      413,
    ],
  ] as const) {
    const invalid: EvidenceExportSource = {
      kind: "cloud",
      snapshot: async () => ({ ...base, entries: [...entries] }),
      read: async () => {
        throw new Error("payload should not be read");
      },
    };
    await assert.rejects(
      createEvidenceBundle("run", invalid),
      status(expected),
    );
  }
  await assert.rejects(createEvidenceBundle("../secret", source), status(400));
});

test("scoped annotations reject mismatched identities and corrupted revision histories", () => {
  assert.throws(
    () =>
      scopeExportAnnotations("run", {
        [reviewName("run")]: JSON.stringify({ ...review(), taskId: "T02" }),
      }),
    status(503),
  );
  assert.throws(
    () =>
      scopeExportAnnotations("run", {
        [reviewName("run")]: JSON.stringify({
          ...review(),
          history: [{ ...review().history[0], revision: 2 }],
        }),
      }),
    status(503),
  );
  assert.throws(
    () =>
      scopeExportAnnotations("run", {
        "attempts.json": JSON.stringify({
          version: 1,
          links: [link("run", "run")],
        }),
      }),
    status(503),
  );
});

test("local bundles preserve bytes and reject linked evidence and active runs", async (t) => {
  const root = await temporary(t);
  const folder = path.join(root, "results/run/T01/1");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(root, "results/run/results.json"), json(manifest));
  await writeFile(path.join(folder, "result.json"), json(trial));
  await writeFile(
    path.join(folder, "baseline.json"),
    json({ existing_files: [] }),
  );
  await writeFile(
    path.join(folder, "task.json"),
    json({ definition: { id: "T01" } }),
  );
  await writeFile(path.join(folder, ".env"), "secret-never-exported");
  const source = localExportSource(root);
  const { inventory } = await unpack(
    t,
    (await createEvidenceBundle("run", source)).stream,
  );
  assert.equal(inventory.source, "local");
  assert.equal(
    inventory.files.filter((file: { path: string }) =>
      file.path.startsWith("evidence/"),
    ).length,
    4,
  );
  await symlink(path.join(folder, ".env"), path.join(folder, "final.jpg"));
  await assert.rejects(createEvidenceBundle("run", source), status(503));
  await rm(path.join(folder, "final.jpg"));
  await writeFile(
    path.join(root, "results/run/results.json"),
    json({ ...manifest, status: "running" }),
  );
  await assert.rejects(createEvidenceBundle("run", source), status(409));
});

test("bundle route enforces the existing signed-session and origin guards before reading storage", async () => {
  const original = Object.fromEntries(
    ["GAUNTLET_STORAGE", "GAUNTLET_PUBLIC_ORIGIN", "GAUNTLET_ADMIN_KEY"].map(
      (key) => [key, process.env[key]],
    ),
  );
  try {
    process.env.GAUNTLET_STORAGE = "vercel";
    process.env.GAUNTLET_PUBLIC_ORIGIN = "https://solaris.example";
    process.env.GAUNTLET_ADMIN_KEY = "export-test-key-".repeat(4);
    const request = (headers: Record<string, string>) =>
      new Request("https://solaris.example/api/runs/run/bundle", {
        headers: { host: "solaris.example", ...headers },
      });
    const context = { params: Promise.resolve({ id: "run" }) };
    assert.equal((await GET(request({}), context)).status, 401);
    assert.equal(
      (
        await GET(
          request({
            cookie: `${SESSION_COOKIE}=${createSession()}`,
            "sec-fetch-site": "cross-site",
          }),
          context,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await GET(request({ cookie: `${SESSION_COOKIE}=${createSession()}` }), {
          params: Promise.resolve({ id: "../invalid" }),
        })
      ).status,
      400,
    );
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
