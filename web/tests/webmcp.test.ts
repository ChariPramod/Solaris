import { test } from "node:test";
import assert from "node:assert/strict";
import { registerWorkspaceTools, type ModelContext } from "../lib/webmcp";
import type { Library } from "../lib/types";
test("optional tools share visible navigation, reject unknown runs, and unregister", async () => {
  const tools = new Map<string, Parameters<ModelContext["registerTool"]>[0]>();
  const signals: AbortSignal[] = [];
  let opened = "";
  const library = {
    runs: [
      {
        id: "saved",
        status: "stopped",
        mode: "dry-run",
        recorded: 1,
        planned_trials: 4,
      },
    ],
    warnings: ["partial"],
  } as Library;
  const dispose = registerWorkspaceTools(
    {
      list: async () => library,
      read: async (id) => {
        const run = library.runs.find((candidate) => candidate.id === id);
        if (!run) throw new Error("Run is unavailable.");
        return run;
      },
      open: (id) => {
        opened = id;
      },
    },
    {
      registerTool(tool, options) {
        tools.set(tool.name, tool);
        signals.push(options.signal);
      },
    },
  );
  assert.equal(tools.size, 2);
  assert.equal(tools.get("list_evaluations")?.annotations.readOnlyHint, true);
  assert.deepEqual(
    await tools.get("start_evaluation_inspection")!.execute({ id: "saved" }),
    { id: "saved", state: "inspection_opened" },
  );
  assert.equal(opened, "saved");
  await assert.rejects(
    tools.get("start_evaluation_inspection")!.execute({ id: "absent" }),
  );
  await assert.rejects(tools.get("list_evaluations")!.execute({ extra: true }));
  dispose();
  assert.ok(signals.every((s) => s.aborted));
});
test("unsupported registry is a no-op", () => {
  assert.doesNotThrow(() =>
    registerWorkspaceTools({
      list: async () => ({
        runs: [],
        warnings: [],
        source: "local",
        scannedAt: "",
      }),
      read: async (id) => ({ id }),
      open: () => {},
    })(),
  );
});

test("evaluation tools expose continuation and inspect known runs beyond the loaded page", async () => {
  const tools = new Map<string, Parameters<ModelContext["registerTool"]>[0]>();
  const calls: unknown[] = [];
  let opened = "";
  const page = { nextCursor: "page-two", limit: 1, scanned: 1 };
  registerWorkspaceTools(
    {
      list: async (options) => {
        calls.push(options);
        return {
          runs: [],
          warnings: ["saved warning"],
          source: "cloud",
          scannedAt: "now",
          page,
        };
      },
      read: async (id) => {
        calls.push(id);
        return { id };
      },
      open: (id) => {
        opened = id;
      },
    },
    {
      registerTool: (tool) => {
        tools.set(tool.name, tool);
      },
    },
  );
  const listed = await tools
    .get("list_evaluations")!
    .execute({ limit: 1, cursor: "opaque+cursor/=" });
  assert.deepEqual(listed, { runs: [], warnings: ["saved warning"], page });
  assert.deepEqual(calls, [{ limit: 1, cursor: "opaque+cursor/=" }]);
  const result = await tools
    .get("start_evaluation_inspection")!
    .execute({ id: "run_beyond_page_one" });
  assert.deepEqual(result, {
    id: "run_beyond_page_one",
    state: "inspection_opened",
  });
  assert.equal(opened, "run_beyond_page_one");
  assert.deepEqual(calls, [
    { limit: 1, cursor: "opaque+cursor/=" },
    "run_beyond_page_one",
  ]);
});

test("tool paging and run identities are validated before any data query", async () => {
  const tools = new Map<string, Parameters<ModelContext["registerTool"]>[0]>();
  let queries = 0;
  let opened = false;
  registerWorkspaceTools(
    {
      list: async () => {
        queries++;
        return { runs: [], warnings: [], source: "local", scannedAt: "now" };
      },
      read: async () => {
        queries++;
        return { id: "wrong-run" };
      },
      open: () => {
        opened = true;
      },
    },
    {
      registerTool: (tool) => {
        tools.set(tool.name, tool);
      },
    },
  );
  for (const input of [
    null,
    [],
    { extra: true },
    { limit: 0 },
    { limit: 201 },
    { limit: NaN },
    { limit: 1.5 },
    { limit: "50" },
    { cursor: "" },
    { cursor: "a\nb" },
    { cursor: "a".repeat(4097) },
  ])
    await assert.rejects(tools.get("list_evaluations")!.execute(input));
  for (const id of ["../secret", "run/id", "", "a".repeat(121)])
    await assert.rejects(
      tools.get("start_evaluation_inspection")!.execute({ id }),
    );
  assert.equal(queries, 0);
  assert.deepEqual(await tools.get("list_evaluations")!.execute({}), {
    runs: [],
    warnings: [],
    page: null,
  });
  await assert.rejects(
    tools.get("start_evaluation_inspection")!.execute({ id: "valid-run" }),
    /unavailable/,
  );
  assert.equal(opened, false);
});
