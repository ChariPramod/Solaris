import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlayback, clickPosition } from "../lib/playback";

test("playback joins action feedback and preserves missing and orphan evidence", () => {
  const frames = buildPlayback(
    [
      {
        step: 1,
        screenshot: "001.jpg",
        action: { kind: "left_click", params: { coordinate: [20, 30] } },
      },
      { step: 1, action_error: "Rejected" },
      { step: 3, screenshot: "003.jpg", action: { kind: "done", params: {} } },
    ],
    ["final.jpg", "002.jpg", "001.jpg"],
  );
  assert.deepEqual(
    frames.map((f) => f.label),
    ["Step 1", "Step 2 · image only", "Step 3", "Final state"],
  );
  assert.equal(frames[0].events.length, 2);
  assert.equal(frames[1].action, undefined);
  assert.equal(frames[2].available, false);
  assert.equal(frames[3].action, undefined);
});

test("feedback cannot replace a distinct action and unlabeled evidence remains inspectable", () => {
  const frames = buildPlayback(
    [
      { step: 1, action_error: "Earlier feedback" },
      { step: 1, action: { kind: "done", params: {} } },
      { response: "Unnumbered response" },
    ],
    [],
  );
  assert.equal(frames.length, 3);
  assert.ok(frames.every((frame) => !frame.available));
  assert.equal(buildPlayback([], []).length, 0);
});

test("click overlay validates action semantics, viewport, and finite in-range integer coordinates", () => {
  const action = { kind: "double_click", params: { coordinate: [640, 360] } };
  assert.deepEqual(clickPosition(action, 1280, 720), { left: 50, top: 50 });
  assert.equal(clickPosition(action, 640, 360), null);
  assert.equal(clickPosition({ ...action, kind: "type" }, 1280, 720), null);
  for (const coordinate of [
    [-1, 0],
    [1280, 20],
    [0, 720],
    [NaN, 20],
    [1.5, 20],
    ["20", 30],
    [20],
  ]) {
    assert.equal(
      clickPosition({ ...action, params: { coordinate } }, 1280, 720),
      null,
    );
  }
  assert.equal(clickPosition({ ...action, params: {} }, 1280, 720), null);
});
