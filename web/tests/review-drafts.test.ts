import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createReviewDraftCache,
  type RetainedDraft,
} from "../lib/review-drafts";
const value = (note: string): RetainedDraft => ({
  draft: {
    verdict: "needs-investigation",
    category: "uncertain",
    note,
    reviewer: "",
  },
  base: { revision: 3, evidenceDigest: "original-digest" },
});
test("navigation drafts retain the original optimistic concurrency identity without sharing mutable objects", () => {
  const cache = createReviewDraftCache();
  const first = value("Unsaved investigation");
  cache.set("run/task/1", first);
  first.draft.note = "Mutated caller";
  const restored = cache.get("run/task/1")!;
  assert.equal(restored.draft.note, "Unsaved investigation");
  assert.deepEqual(restored.base, {
    revision: 3,
    evidenceDigest: "original-digest",
  });
  restored.base.revision = 9;
  assert.equal(cache.get("run/task/1")!.base.revision, 3);
});
test("retention is bounded by recent use and rejects oversized notes", () => {
  const cache = createReviewDraftCache(2);
  cache.set("a", value("a"));
  cache.set("b", value("b"));
  cache.get("a");
  cache.set("c", value("c"));
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a")!.draft.note, "a");
  assert.throws(() => cache.set("big", value("x".repeat(8001))));
  assert.throws(() => createReviewDraftCache(0));
});
test("a late save acknowledgement cannot remove newer edits", () => {
  const cache = createReviewDraftCache();
  const old = value("Submitted note");
  cache.set("trial", old);
  cache.set("trial", value("New edit while old request completes"));
  cache.remove("trial", old);
  assert.equal(
    cache.get("trial")!.draft.note,
    "New edit while old request completes",
  );
  cache.remove("trial", cache.get("trial"));
  assert.equal(cache.get("trial"), undefined);
});
