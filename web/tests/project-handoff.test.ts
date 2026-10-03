import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectHandoff,
  parseHandoffQuery,
  renderProjectHandoff,
} from "../lib/project-handoff";
import type { ClientProject } from "../lib/client-project-types";
import type { Run, Trial } from "../lib/types";
import { StoreError } from "../lib/store";

const id = `project_${"a".repeat(32)}`;
const now = new Date("2026-10-02T12:00:00.000Z");
const digest = "b".repeat(64);
const status = (code: number) => (error: unknown) =>
  error instanceof StoreError && error.status === code;
function project(runIds = ["older_run"]): ClientProject {
  return {
    id,
    revision: 2,
    name: "Workflow acceptance",
    client: "Agency client",
    status: "review",
    notes: "PRIVATE_NOTE",
    runIds,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}
function trial(overrides: Partial<Trial> = {}): Trial {
  return {
    task_id: "T01",
    trial: 1,
    tier: 1,
    model: "test",
    mode: "live",
    passed: true,
    steps: 1,
    wall_seconds: 1,
    termination: "done",
    failure_class: null,
    cleanup_error: null,
    cost_usd: 0.01,
    tokens_in: 2,
    tokens_out: 3,
    artifacts: "SECRET_ARTIFACT",
    evidence: { secret: "PRIVATE_EVIDENCE" },
    error: "PRIVATE_ERROR",
    ...overrides,
  };
}
function run(runId: string, overrides: Partial<Run> = {}): Run {
  return {
    id: runId,
    created_at: now.toISOString(),
    mode: "live",
    model: "test-model",
    status: "complete",
    planned_trials: 1,
    trials_per_task: 1,
    task_ids: ["T01"],
    records: [trial()],
    tasks: {
      T01: {
        definition: {
          id: "T01",
          name: "Task",
          tier: 1,
          prompt: "PRIVATE_PROMPT",
          max_steps: 2,
          max_seconds: 2,
        },
      },
    },
    configuration: { token: "PRIVATE_TOKEN" },
    recovery: { secret: "PRIVATE_RECOVERY" },
    ...overrides,
  };
}

test("handoff queries require an exact saved revision and reject ambiguous or unknown input", () => {
  assert.deepEqual(parseHandoffQuery(new URLSearchParams("revision=2")), {
    revision: 2,
    format: "markdown",
  });
  assert.deepEqual(
    parseHandoffQuery(new URLSearchParams("revision=2&format=json")),
    { revision: 2, format: "json" },
  );
  for (const value of [
    "",
    "revision=0",
    "revision=01",
    "revision=-1",
    "revision=1.5",
    "revision=1e2",
    "revision=9007199254740992",
    "revision=2&revision=2",
    "revision=2&format=json&format=markdown",
    "revision=2&format=html",
    "revision=2&includeNotes=true",
  ])
    assert.throws(
      () => parseHandoffQuery(new URLSearchParams(value)),
      status(400),
      value,
    );
});

test("handoff resolves all assigned IDs directly with six concurrent reads and preserves reference order", async () => {
  const ids = Array.from({ length: 200 }, (_, index) => `old_${index}`);
  let active = 0,
    highest = 0,
    lists = 0;
  const collected: string[] = [];
  const collect = createProjectHandoff({
    async listProjects() {
      lists++;
      return [project(ids)];
    },
    async readRun(runId) {
      collected.push(runId);
      highest = Math.max(highest, ++active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return { run: run(runId), manifestSha256: digest };
    },
    now: () => now,
  });
  const result = await collect(id, 2);
  assert.deepEqual(collected, ids);
  assert.deepEqual(
    result.runs.map((value) => value.id),
    ids,
  );
  assert.equal(result.availableRuns, 200);
  assert.equal(result.unavailableRuns, 0);
  assert.equal(highest, 6);
  assert.equal(lists, 2);
});

test("handoff exports a strict metadata projection without private notes or run internals", async () => {
  const collect = createProjectHandoff({
    listProjects: async () => [project()],
    readRun: async (runId) => ({ run: run(runId), manifestSha256: digest }),
    now: () => now,
  });
  const result = await collect(id, 2);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /PRIVATE_|SECRET_ARTIFACT/);
  assert.equal(result.privateNotesIncluded, false);
  assert.equal(result.project.deliveryStatus, "review");
  assert.equal(result.runs[0].availability, "available");
  const entry = result.runs[0];
  if (entry.availability !== "available") return assert.fail();
  assert.equal(entry.manifestSha256, digest);
  assert.equal(entry.estimatedModelCostUsd, 0.01);
  assert.equal(entry.evidenceBundlePath, "/api/runs/older_run/bundle");
  assert.ok(!("notes" in result.project));
  assert.ok(!("passRate" in result));
  assert.ok(!("cost" in result));
  assert.match(renderProjectHandoff(result), /not an atomic snapshot/);
});

test("missing, changing and corrupt manifests stay explicit without leaking provider errors", async () => {
  const collect = createProjectHandoff({
    listProjects: async () => [
      project(["missing", "changing", "corrupt", "wrong_identity", "good"]),
    ],
    async readRun(runId) {
      if (runId === "missing") throw new StoreError("SECRET_URL", 404);
      if (runId === "changing") throw new StoreError("SECRET_TOKEN", 409);
      if (runId === "corrupt") throw new Error("SECRET_PROVIDER_ERROR");
      return {
        run: run(runId === "wrong_identity" ? "other" : runId),
        manifestSha256: digest,
      };
    },
    now: () => now,
  });
  const result = await collect(id, 2);
  assert.equal(result.unavailableRuns, 4);
  assert.equal(result.availableRuns, 1);
  assert.deepEqual(result.runs.slice(0, 4), [
    { id: "missing", availability: "unavailable", reason: "missing" },
    { id: "changing", availability: "unavailable", reason: "changed" },
    { id: "corrupt", availability: "unavailable", reason: "unavailable" },
    {
      id: "wrong_identity",
      availability: "unavailable",
      reason: "unavailable",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_/);
  assert.match(renderProjectHandoff(result), /No outcome or cost was inferred/);
});

test("incomplete coverage, explicit unknown costs and diagnostic modes remain distinguishable", async () => {
  const variants: Record<string, Partial<Run>> = {
    partial: { planned_trials: 2, trials_per_task: 2 },
    unknown_cost: { records: [trial({ cost_status: "unknown", cost_usd: 0 })] },
    diagnostic: {
      mode: "dry-run",
      records: [trial({ mode: "dry-run", cost_usd: 0 })],
    },
    mixed: { records: [trial({ mode: "dry-run" })] },
    infra: {
      records: [
        trial({
          passed: false,
          failure_class: "infra_error",
          cleanup_error: "PRIVATE_CLEANUP",
        }),
      ],
    },
  };
  const collect = createProjectHandoff({
    listProjects: async () => [project(Object.keys(variants))],
    readRun: async (runId) => ({
      run: run(runId, variants[runId]),
      manifestSha256: digest,
    }),
    now: () => now,
  });
  const result = await collect(id, 2);
  const entries = result.runs.filter(
    (value) => value.availability === "available",
  );
  assert.equal(entries[0].estimatedModelCostUsd, null);
  assert.equal(entries[0].missingTrials, 1);
  assert.equal(entries[1].estimatedModelCostUsd, null);
  assert.equal(entries[1].unknownCostTrials, 1);
  assert.equal(entries[2].mode, "diagnostic");
  assert.equal(entries[2].estimatedModelCostUsd, 0);
  assert.equal(entries[3].mode, "unknown");
  assert.equal(entries[4].infrastructureFailures, 1);
  assert.equal(entries[4].cleanupErrors, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CLEANUP/);
  assert.match(
    renderProjectHandoff(result),
    /diagnostic \/ non-live; not AI model performance/,
  );
});

test("stale project revisions fail before reads and concurrent revisions invalidate the export", async () => {
  let reads = 0,
    lists = 0;
  const collect = createProjectHandoff({
    listProjects: async () => [{ ...project(), revision: ++lists > 1 ? 3 : 2 }],
    readRun: async (runId) => {
      reads++;
      return { run: run(runId), manifestSha256: digest };
    },
    now: () => now,
  });
  await assert.rejects(collect(id, 1), status(409));
  assert.equal(reads, 0);
  lists = 0;
  await assert.rejects(collect(id, 2), status(409));
  assert.equal(reads, 1);
});

test("empty projects remain explicit and unavailable projects fail without evidence reads", async () => {
  let reads = 0;
  const collect = createProjectHandoff({
    listProjects: async () => [project([])],
    readRun: async () => {
      reads++;
      throw new Error();
    },
    now: () => now,
  });
  const result = await collect(id, 2);
  assert.equal(result.assignedRuns, 0);
  assert.match(renderProjectHandoff(result), /No evaluations are assigned/);
  await assert.rejects(collect(`project_${"c".repeat(32)}`, 2), status(404));
  assert.equal(reads, 0);
});

test("aborting collection prevents partial exports and further batches", async () => {
  const abort = new AbortController();
  let reads = 0;
  const collect = createProjectHandoff({
    listProjects: async () => [
      project(Array.from({ length: 20 }, (_, index) => `run_${index}`)),
    ],
    readRun: async (runId) => {
      reads++;
      abort.abort();
      return { run: run(runId), manifestSha256: digest };
    },
    now: () => now,
  });
  await assert.rejects(collect(id, 2, abort.signal), { name: "AbortError" });
  assert.ok(reads <= 6);
  const before = reads;
  await assert.rejects(collect(id, 2, abort.signal), { name: "AbortError" });
  assert.equal(reads, before);
});

test("Markdown renders user fields literally rather than HTML, images, links or injected headings", async () => {
  const collect = createProjectHandoff({
    listProjects: async () => [
      {
        ...project(),
        name: "[click](https://evil.example) | <script>alert(1)</script>",
        client: "![remote](https://evil.example/pixel)\n# injected",
      },
    ],
    readRun: async (runId) => ({
      run: run(runId, { model: "`x`\n# heading <img src=x>" }),
      manifestSha256: digest,
    }),
    now: () => now,
  });
  const text = renderProjectHandoff(await collect(id, 2));
  assert.ok(text.includes("\\[click\\]\\(https\\://evil\\.example\\)"));
  assert.ok(text.includes("&lt;script&gt;"));
  assert.ok(text.includes("\\!\\[remote\\]"));
  assert.doesNotMatch(text, /<script>|<img|\n# injected|\n# heading/);
});
