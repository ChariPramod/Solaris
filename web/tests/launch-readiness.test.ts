import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  liveCheckAllowsLaunch,
  setupIdentity,
  LIVE_CHECK_LIFETIME,
  type LaunchCheck,
} from "../lib/launch-readiness";
import { CloudLiveLaunch } from "../components/cloud-live-launch";
import { WorkspaceIntro } from "../components/workspace-intro";
import type { RunSetup, RunCard } from "../lib/types";
const setup: RunSetup = {
  tasks: ["T01", "T02"],
  trials: 1,
  concurrency: 1,
  maxInfraFailures: 1,
  provider: "claude",
  modelId: "",
};
const check: LaunchCheck = {
  setup: setupIdentity(setup),
  checkedAt: 1000000,
  result: {
    ready: true,
    checks: [{ name: "Storage", status: "pass", message: "Reachable" }],
    scope: "Configuration",
    planned_trials: 2,
  },
};
test("live launch requires a recent successful check for the exact plan", () => {
  assert.equal(liveCheckAllowsLaunch(check, setup, 1000001), true);
  assert.equal(liveCheckAllowsLaunch(null, setup, 1000001), false);
  assert.equal(liveCheckAllowsLaunch(check, setup, 999999), false);
  assert.equal(
    liveCheckAllowsLaunch(check, setup, 1000000 + LIVE_CHECK_LIFETIME),
    false,
  );
  for (const change of [
    { provider: "openai" as const },
    { modelId: "other-model" },
    { tasks: ["T01"] },
    { trials: 2 },
    { concurrency: 2 },
    { maxInfraFailures: 2 },
  ])
    assert.equal(
      liveCheckAllowsLaunch(check, { ...setup, ...change }, 1000001),
      false,
    );
});
test("failed, empty or contradictory checks cannot enable live launch", () => {
  for (const result of [
    { ...check.result, ready: false },
    { ...check.result, checks: [] },
    {
      ...check.result,
      checks: [
        { name: "Provider", status: "fail" as const, message: "Missing" },
      ],
    },
  ])
    assert.equal(
      liveCheckAllowsLaunch({ ...check, result }, setup, 1000001),
      false,
    );
});
test("live launch initially explains preflight scope and disables execution", () => {
  const html = renderToStaticMarkup(
    createElement(CloudLiveLaunch, { setup, busy: false, onLaunch: () => {} }),
  );
  assert.match(html, /Check live setup/);
  assert.match(
    html,
    /authenticated by the providers only when a live run starts/,
  );
  assert.match(
    html,
    /<button[^>]*disabled=""[^>]*>[\s\S]*Start live evaluation/,
  );
});
test("getting started uses real complete evidence and distinguishes diagnostics from benchmarks", () => {
  const base: RunCard = {
    id: "complete",
    created_at: "2026-09-22",
    mode: "dry-run",
    model: "static",
    status: "complete",
    planned_trials: 2,
    trials_per_task: 1,
    task_ids: ["T01", "T02"],
    recorded: 2,
    passed: 0,
    infra: 0,
    cleanup: 0,
    cost: 0,
  };
  const render = (runs: RunCard[]) =>
    renderToStaticMarkup(
      createElement(WorkspaceIntro, {
        library: { runs, warnings: [], source: "cloud", scannedAt: "now" },
        onOpen: () => {},
        onCreate: () => {},
        onReadiness: () => {},
      }),
    );
  assert.match(render([base]), /Inspect latest diagnostic/);
  assert.match(render([base]), /No live evaluations are saved/);
  assert.doesNotMatch(
    render([{ ...base, recorded: 1 }]),
    /Inspect latest diagnostic/,
  );
  assert.doesNotMatch(
    render([{ ...base, cleanup: 1 }]),
    /Inspect latest diagnostic/,
  );
  assert.match(
    render([{ ...base, mode: "live" }]),
    /Saved evidence still needs human review/,
  );
  assert.match(render([]), /A completed run will appear here/);
});
