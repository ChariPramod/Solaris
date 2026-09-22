import test from "node:test";
import assert from "node:assert/strict";
import { listCloudJobs } from "../lib/cloud-job-list";
import type { PublicCloudJob } from "../lib/cloud-runner";
import { StoreError } from "../lib/store";

const id = (value: number) => `cloud_${value.toString(16).padStart(32, "0")}`;
const key = (value: number) => `jobs/${id(value)}.json`;
function job(
  value: number,
  createdAt = "2026-09-22T00:00:00.000Z",
): PublicCloudJob {
  return {
    id: id(value),
    mode: "dry-run",
    status: "complete",
    createdAt,
    updatedAt: createdAt,
    expiresAt: "2026-09-22T01:00:00.000Z",
    sourceRevision: "a".repeat(40),
    setup: {
      tasks: ["T01"],
      trials: 1,
      concurrency: 1,
      maxInfraFailures: 1,
      provider: "claude",
      modelId: "",
    },
  };
}

test("corrupt and expiry-reconciliation failures preserve sorted healthy jobs without exposing errors", async () => {
  const result = await listCloudJobs({
    listKeys: async (prefix, limit) => {
      assert.equal(prefix, "jobs/");
      assert.equal(limit, 200);
      return { keys: [key(1), key(2), key(3), key(4)], truncated: false };
    },
    getPublicCloudJob: async (value) => {
      if (value === id(2)) throw new Error("SDK secret callbackToken=private");
      if (value === id(3))
        throw new StoreError(
          "Expired job CAS failed with private credentials",
          409,
        );
      return job(
        value === id(1) ? 1 : 4,
        value === id(1)
          ? "2026-09-21T00:00:00.000Z"
          : "2026-09-22T00:00:00.000Z",
      );
    },
  });
  assert.deepEqual(
    result.jobs.map((item) => item.id),
    [id(4), id(1)],
  );
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], new RegExp(id(2)));
  assert.match(result.warnings[1], new RegExp(id(3)));
  assert.doesNotMatch(
    JSON.stringify(result),
    /private|callbackToken|credentials|SDK/,
  );
  assert.equal(result.truncated, false);
});

test("invalid and duplicate keys are skipped before reading and listing truncation remains explicit", async () => {
  const reads: string[] = [];
  const result = await listCloudJobs({
    listKeys: async () => ({
      keys: [
        "jobs/not-a-job.json",
        "elsewhere/secret",
        "jobs/../secret",
        key(1),
        key(1),
      ],
      truncated: true,
    }),
    getPublicCloudJob: async (value) => {
      reads.push(value);
      return job(1);
    },
  });
  assert.deepEqual(reads, [id(1)]);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^4 invalid or duplicate/);
  assert.doesNotMatch(result.warnings[0], /secret/);
});

test("reads remain bounded to 200 entries with at most eight concurrent jobs", async () => {
  let active = 0,
    peak = 0,
    reads = 0;
  const result = await listCloudJobs({
    listKeys: async () => ({
      keys: Array.from({ length: 205 }, (_, index) => key(index)),
      truncated: false,
    }),
    getPublicCloudJob: async (value) => {
      active++;
      reads++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return job(Number.parseInt(value.slice(6), 16));
    },
  });
  assert.equal(reads, 200);
  assert.equal(peak, 8);
  assert.equal(result.jobs.length, 200);
  assert.equal(result.truncated, true);
});

test("whole-list outage is an explicit sanitized failure, while an empty archive is valid", async () => {
  await assert.rejects(
    listCloudJobs({
      listKeys: async () => {
        throw new Error("SDK token private");
      },
      getPublicCloudJob: async () => job(1),
    }),
    (error) =>
      error instanceof StoreError &&
      error.status === 503 &&
      !error.message.includes("private"),
  );
  assert.deepEqual(
    await listCloudJobs({
      listKeys: async () => ({ keys: [], truncated: false }),
      getPublicCloudJob: async () => {
        throw new Error("Should not read");
      },
    }),
    { jobs: [], warnings: [], truncated: false },
  );
});
