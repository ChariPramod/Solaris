import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CloudAccess } from "../components/cloud-access";
import { Workspace } from "../components/workspace";

test("cloud session gate does not render workspace contents until authenticated", () => {
  const markup = renderToStaticMarkup(
    createElement(CloudAccess, {
      cloud: true,
      children: createElement("div", null, "PRIVATE_EVIDENCE_CONTENT"),
    }),
  );
  assert.match(markup, /Checking session/);
  assert.doesNotMatch(markup, /PRIVATE_EVIDENCE_CONTENT/);
});

test("local mode retains direct workspace access", () => {
  const markup = renderToStaticMarkup(
    createElement(CloudAccess, {
      cloud: false,
      children: createElement("div", null, "LOCAL_WORKSPACE"),
    }),
  );
  assert.match(markup, /LOCAL_WORKSPACE/);
  assert.doesNotMatch(markup, /Checking session/);
});

test("cloud workspace labels describe persisted evidence and execution jobs", () => {
  const markup = renderToStaticMarkup(
    createElement(Workspace, { cloud: true }),
  );
  assert.match(markup, /Execution jobs/);
  assert.match(markup, /Cloud workspace/);
  assert.match(markup, /persistent cloud evidence/);
  assert.doesNotMatch(markup, /Everything stays local/);
  assert.doesNotMatch(markup, /No cloud upload/);
});

test("local workspace preserves local operations and omits cloud job polling panel", () => {
  const markup = renderToStaticMarkup(createElement(Workspace));
  assert.match(markup, /Everything stays local/);
  assert.doesNotMatch(markup, /Execution jobs/);
});
