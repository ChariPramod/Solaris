import assert from "node:assert/strict";
import test from "node:test";
import { libraryQuery } from "../lib/library-query";
import { mergeLibrary } from "../lib/library-pagination";
import type { Library, RunCard } from "../lib/types";
import { StoreError } from "../lib/store";

test("library queries bound page sizes and preserve opaque continuations", () => {
  assert.deepEqual(libraryQuery("https://solaris.example/api/runs"), {
    limit: 50,
  });
  assert.deepEqual(
    libraryQuery(
      "https://solaris.example/api/runs?limit=200&cursor=a%2Bb%2F%3D",
    ),
    { limit: 200, cursor: "a+b/=" },
  );
  for (const query of [
    "limit=0",
    "limit=201",
    "limit=1.5",
    "limit=-1",
    "limit=01",
    "limit=50&limit=100",
    "cursor=",
    "cursor=a&cursor=b",
    "cursor=a%0Ab",
  ]) {
    assert.throws(
      () => libraryQuery(`https://solaris.example/api/runs?${query}`),
      (e: unknown) => e instanceof StoreError && e.status === 400,
    );
  }
});

test("page merge preserves earlier evidence, replaces duplicate IDs and sorts loaded data without mutating pages", () => {
  const card = (id: string, created_at: string, status = "running") =>
    ({ id, created_at, status }) as RunCard;
  const current: Library = {
    runs: [card("a", "2026-01-01"), card("b", "2026-01-03")],
    warnings: ["old unavailable"],
    source: "cloud",
    scannedAt: "first",
    page: { nextCursor: "two", limit: 2, scanned: 2 },
  };
  const next: Library = {
    runs: [card("b", "2026-01-03", "complete"), card("c", "2026-01-02")],
    warnings: ["old unavailable", "new unavailable"],
    source: "cloud",
    scannedAt: "second",
    page: { nextCursor: null, limit: 2, scanned: 2 },
  };
  const result = mergeLibrary(current, next);
  assert.deepEqual(
    result.runs.map((r) => [r.id, r.status]),
    [
      ["b", "complete"],
      ["c", "running"],
      ["a", "running"],
    ],
  );
  assert.deepEqual(result.warnings, ["old unavailable", "new unavailable"]);
  assert.equal(result.page?.nextCursor, null);
  assert.equal(current.runs[1].status, "running");
  assert.equal(next.runs.length, 2);
});
