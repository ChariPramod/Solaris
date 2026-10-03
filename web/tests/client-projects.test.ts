import test from "node:test";
import assert from "node:assert/strict";
import { createClientProjects } from "../lib/client-projects";
import { StoreError } from "../lib/store";
import { GET, POST } from "../app/api/projects/route";
import { createSession, SESSION_COOKIE } from "../lib/cloud-auth";
import type * as cloudStorage from "../lib/cloud-storage";

const key = "workspace/client-projects.json";
function fixture() {
  const data = new Map<string, { value: unknown; etag: string }>();
  const reads: string[] = [];
  let revision = 0;
  const storage: Pick<typeof cloudStorage, "readJSON" | "writeJSON"> = {
    async readJSON<T>(id: string) {
      const value = data.get(id);
      return value
        ? (structuredClone(value) as { value: T; etag: string })
        : null;
    },
    async writeJSON(id, value, expected) {
      if ((data.get(id)?.etag ?? null) !== expected)
        throw new StoreError("Save conflict", 409);
      const etag = String(++revision);
      data.set(id, { value: structuredClone(value), etag });
      return { etag };
    },
  };
  let missing: string | null = null;
  const readEvidence = async (id: string) => {
    reads.push(id);
    if (id === missing) throw new StoreError("Missing evidence", 404);
    return { id };
  };
  return {
    service: createClientProjects(storage, readEvidence),
    storage,
    data,
    reads,
    readEvidence,
    missing: (id: string) => {
      missing = id;
    },
  };
}
const status = (expected: number) => (error: unknown) =>
  error instanceof StoreError && error.status === expected;
const input = {
  revision: 0,
  name: "Invoice automation",
  client: "Example agency client",
  runIds: ["run_a"],
};

test("client projects persist separately and validate only newly assigned references", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.listProjects(), []);
  const project = await f.service.saveProject({
    ...input,
    name: "  Invoice automation  ",
  });
  assert.equal(project.name, "Invoice automation");
  assert.equal(project.revision, 1);
  assert.equal(project.status, "active");
  assert.equal(project.notes, "");
  assert.deepEqual(f.reads, ["run_a"]);
  assert.deepEqual([...f.data.keys()], [key]);
  const fresh = createClientProjects(f.storage, f.readEvidence);
  assert.deepEqual(await fresh.listProjects(), [project]);
  f.missing("run_a");
  const saved = await fresh.saveProject({
    ...input,
    id: project.id,
    runIds: ["run_a", "run_b"],
    name: "Updated",
    revision: 1,
  });
  assert.equal(saved.revision, 2);
  assert.deepEqual(f.reads, ["run_a", "run_b"]);
  assert.equal(saved.createdAt, project.createdAt);
  await fresh.saveProject({ ...input, id: saved.id, revision: 2, runIds: [] });
  assert.deepEqual(f.reads, ["run_a", "run_b"]);
});

test("missing references fail atomically and do not change existing project data", async () => {
  const f = fixture();
  const project = await f.service.saveProject(input);
  const original = JSON.stringify(f.data.get(key));
  f.missing("missing");
  await assert.rejects(
    f.service.saveProject({
      ...input,
      id: project.id,
      revision: 1,
      runIds: ["run_a", "missing"],
    }),
    status(409),
  );
  assert.equal(JSON.stringify(f.data.get(key)), original);
});

test("stale project revisions and concurrent metadata writes cannot lose updates", async () => {
  const f = fixture();
  const project = await f.service.saveProject(input);
  await f.service.saveProject({
    ...input,
    id: project.id,
    revision: 1,
    name: "New version",
  });
  await assert.rejects(
    f.service.saveProject({ ...input, id: project.id, revision: 1 }),
    status(409),
  );
  const writes = await Promise.allSettled([
    f.service.saveProject(input),
    f.service.saveProject({ ...input, name: "Other" }),
  ]);
  assert.equal(
    writes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    writes.filter(
      (result) => result.status === "rejected" && status(409)(result.reason),
    ).length,
    1,
  );
  assert.equal((await f.service.listProjects()).length, 2);
});

test("project input validation rejects unsafe IDs, duplicates, bounds and extra fields before writes", async () => {
  const f = fixture();
  for (const value of [
    { ...input, runIds: ["../escape"] },
    { ...input, runIds: ["same", "same"] },
    { ...input, name: " " },
    { ...input, client: "x".repeat(121) },
    { ...input, name: "x".repeat(81) },
    { ...input, name: "hidden\ncontrol" },
    { ...input, status: "passed" },
    { ...input, status: null },
    { ...input, notes: null },
    { ...input, notes: "x".repeat(2001) },
    { ...input, notes: "hidden\u0000control" },
    { ...input, notes: "hidden\u001bcontrol" },
    { ...input, runIds: Array.from({ length: 201 }, (_, i) => `run_${i}`) },
    { ...input, revision: 1 },
    { ...input, id: `project_${"a".repeat(32)}` },
    { ...input, token: "secret" },
  ])
    await assert.rejects(f.service.saveProject(value), status(400));
  assert.equal(f.data.size, 0);
  assert.equal(f.reads.length, 0);
});

test("legacy records get delivery defaults without a write; older updates preserve saved status and notes", async () => {
  const f = fixture();
  const now = new Date().toISOString();
  const legacy = {
    ...input,
    id: `project_${"a".repeat(32)}`,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const document = { version: 1, projects: [legacy] };
  f.data.set(key, { value: document, etag: "legacy" });
  const [read] = await f.service.listProjects();
  assert.equal(read.status, "active");
  assert.equal(read.notes, "");
  assert.deepEqual(f.data.get(key), { value: document, etag: "legacy" });

  const updated = await f.service.saveProject({
    ...input,
    id: legacy.id,
    revision: 1,
    status: "review",
    notes: "  Confirm the invoice mapping.\nClient contact:\tSam  ",
  });
  assert.equal(
    updated.notes,
    "Confirm the invoice mapping.\nClient contact:\tSam",
  );
  const olderCaller = await f.service.saveProject({
    ...input,
    id: updated.id,
    revision: updated.revision,
    name: "Renamed by older caller",
  });
  assert.equal(olderCaller.status, "review");
  assert.equal(olderCaller.notes, updated.notes);
  assert.equal(olderCaller.createdAt, now);
  assert.deepEqual(f.reads, []);
});

test("delivery status changes and note edits are independent, bounded and reversible without evidence writes", async () => {
  const f = fixture();
  let project = await f.service.saveProject({
    ...input,
    notes: "x".repeat(2000),
    status: "delivered",
  });
  f.missing("run_a");
  for (const delivery of [
    "archived",
    "active",
    "review",
    "delivered",
  ] as const) {
    project = await f.service.saveProject({
      ...input,
      id: project.id,
      revision: project.revision,
      status: delivery,
    });
    assert.equal(project.status, delivery);
    assert.equal(project.notes.length, 2000);
    assert.deepEqual(project.runIds, ["run_a"]);
  }
  const cleared = await f.service.saveProject({
    ...input,
    id: project.id,
    revision: project.revision,
    notes: "",
  });
  assert.equal(cleared.notes, "");
  assert.equal(cleared.status, "delivered");
  assert.deepEqual(f.reads, ["run_a"]);
  assert.deepEqual([...f.data.keys()], [key]);
});

test("concurrent delivery edits reject stale revisions and preserve the entire winning revision", async () => {
  const f = fixture();
  const project = await f.service.saveProject(input);
  const changes = [
    { status: "review", notes: "Waiting for client review" },
    { status: "archived", notes: "Engagement paused" },
  ];
  const results = await Promise.allSettled(
    changes.map((change) =>
      f.service.saveProject({
        ...input,
        id: project.id,
        revision: 1,
        ...change,
      }),
    ),
  );
  const successes = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  assert.equal(successes.length, 1);
  assert.equal(
    results.filter(
      (result) => result.status === "rejected" && status(409)(result.reason),
    ).length,
    1,
  );
  assert.deepEqual(await f.service.listProjects(), successes);
  await assert.rejects(
    f.service.saveProject({
      ...input,
      id: project.id,
      revision: 1,
      status: "delivered",
      notes: "Stale draft",
    }),
    status(409),
  );
  assert.deepEqual(await f.service.listProjects(), successes);
});

test("malformed stored delivery metadata fails closed instead of silently resetting progress", async () => {
  const f = fixture();
  const project = await f.service.saveProject(input);
  for (const change of [
    { status: "passed" },
    { status: null },
    { notes: null },
    { notes: "x".repeat(2001) },
    { notes: "hidden\u0000control" },
  ]) {
    const document = { version: 1, projects: [{ ...project, ...change }] };
    f.data.set(key, { value: document, etag: "corrupt" });
    await assert.rejects(f.service.listProjects(), status(503));
    await assert.rejects(f.service.saveProject(input), status(503));
    assert.deepEqual(f.data.get(key)?.value, document);
  }
});

test("corrupt metadata is preserved and project limit is enforced", async () => {
  const f = fixture();
  for (const bad of [{ bad: true }, null]) {
    f.data.set(key, { value: bad, etag: "corrupt" });
    await assert.rejects(f.service.listProjects(), status(503));
    await assert.rejects(f.service.saveProject(input), status(503));
    assert.deepEqual(f.data.get(key)?.value, bad);
  }
  const now = new Date().toISOString();
  f.data.set(key, {
    value: {
      version: 1,
      projects: Array.from({ length: 100 }, (_, i) => ({
        id: `project_${i.toString(16).padStart(32, "0")}`,
        revision: 1,
        name: `Project ${i}`,
        client: "Client",
        runIds: [],
        createdAt: now,
        updatedAt: now,
      })),
    },
    etag: "full",
  });
  await assert.rejects(f.service.saveProject(input), status(409));
  const updated = await f.service.saveProject({
    ...input,
    runIds: [],
    id: `project_${"0".repeat(32)}`,
    revision: 1,
  });
  assert.equal(updated.revision, 2);
  assert.equal((await f.service.listProjects()).length, 100);
});

test("project assignment checks bound concurrency and await all checks before saving", async () => {
  const f = fixture();
  let active = 0,
    max = 0,
    finished = 0;
  const service = createClientProjects(f.storage, async () => {
    active++;
    max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    finished++;
  });
  const saved = await service.saveProject({
    ...input,
    runIds: Array.from({ length: 14 }, (_, i) => `run_${i}`),
  });
  assert.equal(saved.runIds.length, finished);
  assert.equal(max, 6);
});

test("project routes require cloud owner authentication and same-origin writes", async () => {
  const keys = [
    "GAUNTLET_STORAGE",
    "GAUNTLET_ADMIN_KEY",
    "GAUNTLET_PUBLIC_ORIGIN",
  ];
  const previous = keys.map((id) => process.env[id]);
  Object.assign(process.env, {
    GAUNTLET_STORAGE: "vercel",
    GAUNTLET_ADMIN_KEY: "test-only".repeat(8),
    GAUNTLET_PUBLIC_ORIGIN: "https://solaris.example",
  });
  const request = (
    method: string,
    cookie = "",
    origin = "https://solaris.example",
    raw = "{}",
  ) =>
    new Request("https://solaris.example/api/projects", {
      method,
      headers: {
        host: "solaris.example",
        origin,
        cookie,
        "content-type": "application/json",
      },
      ...(method === "POST" ? { body: raw } : {}),
    });
  try {
    assert.equal((await GET(request("GET"))).status, 401);
    assert.equal((await POST(request("POST"))).status, 401);
    const cookie = `${SESSION_COOKIE}=${createSession()}`;
    assert.equal(
      (await POST(request("POST", cookie, "https://other.example"))).status,
      403,
    );
    assert.equal((await POST(request("POST", cookie))).status, 400);
    assert.equal(
      (await POST(request("POST", cookie, undefined, "x".repeat(33000))))
        .status,
      413,
    );
    delete process.env.GAUNTLET_STORAGE;
    assert.equal(
      (
        await GET(
          new Request("http://localhost/api/projects", {
            headers: { host: "localhost" },
          }),
        )
      ).status,
      404,
    );
  } finally {
    keys.forEach((id, i) => {
      if (previous[i] === undefined) delete process.env[id];
      else process.env[id] = previous[i];
    });
  }
});
