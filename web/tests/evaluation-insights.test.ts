import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { calculateInsights, runOutcomes } from "../lib/evaluation-insights";
import { WORKFLOW_TEMPLATES, templateSetup } from "../lib/workflow-templates";
import { setupSchema } from "../lib/harness";
import { TASK_IDS } from "../lib/domain";
import { EvaluationInsights } from "../components/evaluation-insights";
import { WorkflowTemplates } from "../components/workflow-templates";
import type { RunCard } from "../lib/types";

function run(id: string, values: Partial<RunCard> = {}): RunCard {
  return {
    id,
    created_at: "2026-10-02T01:00:00Z",
    model: "test-model",
    mode: "live",
    status: "complete",
    task_ids: ["T01", "T02"],
    planned_trials: 2,
    trials_per_task: 1,
    recorded: 2,
    passed: 1,
    infra: 0,
    cleanup: 0,
    cost: 0.5,
    ...values,
  };
}

test("insights never mix diagnostics with live performance or drop unrecorded trials", () => {
  const results = calculateInsights(
    [
      run("live"),
      run("partial", {
        status: "interrupted",
        planned_trials: 4,
        recorded: 1,
        passed: 1,
        cost: null,
      }),
      run("diagnostic", { mode: "dry-run", passed: 2, cost: 0 }),
      run("unknown", { mode: "legacy" }),
    ],
    { mode: "live" },
  );
  assert.equal(results.runCount, 2);
  assert.equal(results.planned, 6);
  assert.equal(results.recorded, 3);
  assert.equal(results.plannedPassRate, 2 / 6);
  assert.equal(results.coverage, 0.5);
  assert.equal(results.unrecorded, 3);
  assert.equal(results.complete, 1);
  assert.equal(results.unknownModeRuns, 1);
  assert.equal(results.knownCostRuns, 1);
  assert.equal(results.unknownCostRuns, 1);
  assert.equal(results.cost, 0.5);
});

test("unknown or incomplete costs are never represented as zero", () => {
  for (const badCost of [null, Number.NaN, Infinity, -1]) {
    const results = calculateInsights([run("unknown", { cost: badCost })], {
      mode: "live",
    });
    assert.equal(results.cost, null);
    assert.equal(results.unknownCostRuns, 1);
  }
  assert.equal(
    calculateInsights([run("incomplete", { recorded: 1, cost: 0 })], {
      mode: "live",
    }).cost,
    null,
  );
  assert.equal(
    calculateInsights([run("zero", { cost: 0 })], { mode: "live" }).cost,
    0,
  );
  assert.equal(calculateInsights([], { mode: "live" }).plannedPassRate, null);
});

test("outcomes keep task failure, infrastructure and unrecorded evidence distinct", () => {
  assert.deepEqual(
    runOutcomes(
      run("mixed", {
        planned_trials: 6,
        recorded: 4,
        passed: 2,
        infra: 1,
        cleanup: 1,
      }),
    ),
    { passed: 2, failed: 1, infrastructure: 1, unrecorded: 2 },
  );
  for (const bad of [
    { passed: 3 },
    { recorded: 3 },
    { infra: 2 },
    { cleanup: 3 },
    { planned_trials: -1 },
    { recorded: 0.5 },
  ]) {
    assert.equal(runOutcomes(run("invalid", bad)), null);
    assert.equal(
      calculateInsights([run("invalid", bad)], { mode: "live" }).excluded,
      1,
    );
  }
});

test("filtering and recent runs preserve input order, deduplicate IDs and tolerate invalid dates", () => {
  const values = [
    run("old", { created_at: "not-a-date" }),
    run("new", { model: "second" }),
    run("old"),
  ];
  const copy = JSON.stringify(values);
  const result = calculateInsights(values, { mode: "live" });
  assert.deepEqual(
    result.recent.map((value) => value.id),
    ["new", "old"],
  );
  assert.deepEqual(result.models, ["second", "test-model"]);
  assert.equal(result.runCount, 2);
  assert.equal(
    calculateInsights(values, { mode: "live", model: "second" }).runCount,
    1,
  );
  assert.equal(JSON.stringify(values), copy);
});

test("starter workflows only use shipped tasks and validate against launch constraints", () => {
  assert.deepEqual(
    [...new Set(WORKFLOW_TEMPLATES.flatMap((item) => item.tasks))].sort(),
    TASK_IDS,
  );
  for (const template of WORKFLOW_TEMPLATES) {
    const setup = templateSetup(template.id, {
      provider: "openai",
      modelId: "test-model",
    });
    assert.equal(setupSchema.safeParse(setup).success, true);
    assert.equal(setup.provider, "openai");
    assert.equal(setup.modelId, "test-model");
    assert.equal(setup.concurrency, 1);
    assert.equal(setup.maxInfraFailures, 1);
    setup.tasks.pop();
    assert.equal(
      templateSetup(template.id).tasks.length,
      template.tasks.length,
    );
  }
  assert.throws(() => templateSetup("unknown" as never), /Unknown workflow/);
});

test("insights and templates render loading, empty and evidence limitations explicitly", () => {
  const render = (runs: RunCard[], loading = false) =>
    renderToStaticMarkup(
      createElement(EvaluationInsights, { runs, loading, onOpen: () => {} }),
    );
  assert.match(render([], true), /Loading saved evaluation evidence/);
  assert.match(render([]), /No diagnostic evidence/);
  const diagnostic = render([
    run("diagnostic", { mode: "dry-run", passed: 0 }),
  ]);
  assert.match(diagnostic, /do not measure AI performance/);
  assert.match(diagnostic, /Missing trials remain in the denominator/);
  assert.match(diagnostic, /excludes desktop and hosting charges/);
  assert.match(render([run("live")]), /Live agents/);
  const templates = renderToStaticMarkup(
    createElement(WorkflowTemplates, { onSelect: () => {}, disabled: true }),
  );
  assert.equal((templates.match(/disabled=""/g) || []).length, 4);
  assert.match(templates, /not a comprehensive safety certification/);
  assert.doesNotMatch(templates, /Start live evaluation/);
});
