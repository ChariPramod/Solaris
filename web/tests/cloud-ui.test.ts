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

test("public overview explains real product capabilities without claiming live benchmark scores", () => {
  const markup = renderToStaticMarkup(
    createElement(CloudAccess, {
      cloud: true,
      children: createElement("div", null, "PRIVATE_EVIDENCE_CONTENT"),
    }),
  );
  assert.match(markup, /12 built-in tasks/);
  assert.match(markup, /Two model adapters/);
  assert.match(markup, /Run a repeatable task/);
  assert.match(markup, /Inspect what happened/);
  assert.match(markup, /Check what changed/);
  assert.match(markup, /There are no verified live benchmark results yet/);
  assert.match(markup, /Dry runs test the harness with a static agent/);
  assert.match(markup, /Source code is public; run data stays private/);
  assert.match(markup, /href="https:\/\/github.com\/ChariPramod\/Solaris"/);
  assert.doesNotMatch(markup, /PRIVATE_EVIDENCE_CONTENT/);
});

test("public overview keeps navigation and login sections accessible during session checking", () => {
  const markup = renderToStaticMarkup(
    createElement(CloudAccess, { cloud: true, children: null }),
  );
  assert.match(markup, /href="#product-overview"/);
  assert.match(markup, /id="product-overview"/);
  assert.match(markup, /aria-labelledby="workspace-signin-title"/);
  assert.match(markup, /id="workspace-signin-title"/);
  assert.match(markup, /role="status"/);
  assert.equal((markup.match(/<h1\b/g) ?? []).length, 1);
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
