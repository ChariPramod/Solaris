import test from "node:test";
import assert from "node:assert/strict";
import { jobQuery } from "../lib/job-query";
import { StoreError } from "../lib/store";

test("jobs use shared validated pagination and an independent reservation view", () => {
  assert.deepEqual(jobQuery("https://example.test/api/jobs"), {
    view: "history",
    limit: 50,
  });
  assert.deepEqual(
    jobQuery("https://example.test/api/jobs?limit=3&cursor=opaque%3Aabc"),
    { view: "history", limit: 3, cursor: "opaque:abc" },
  );
  assert.deepEqual(jobQuery("https://example.test/api/jobs?view=reserved"), {
    view: "reserved",
  });
  for (const query of [
    "limit=201",
    "limit=0",
    "limit=1&limit=2",
    "cursor=",
    "cursor=a&cursor=b",
    "view=bogus",
    "view=history&view=reserved",
    "view=reserved&limit=1",
    "view=reserved&cursor=a",
  ]) {
    assert.throws(
      () => jobQuery(`https://example.test/api/jobs?${query}`),
      (error) => error instanceof StoreError && error.status === 400,
    );
  }
});
