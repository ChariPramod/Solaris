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
      open: () => {},
    })(),
  );
});
