import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeJobs,
  mergeJobPage,
  refreshUntrackedJobs,
  visibleJobs,
} from "../lib/job-pagination";
import type { PublicCloudJob } from "../lib/cloud-runner";
import type { CloudJobList } from "../lib/cloud-job-list";

const job = (
  id: string,
  status: PublicCloudJob["status"],
  updatedAt = "2026-10-02T00:00:00.000Z",
) =>
  ({
    id,
    status,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt,
  }) as PublicCloudJob;
const page = (jobs: PublicCloudJob[]): CloudJobList => ({
  jobs,
  warnings: [],
  truncated: false,
  page: { limit: 25, scanned: jobs.length, nextCursor: null },
});

test("paged history deduplicates without replacing fresher status from independent polling", () => {
  const current = page([job("a", "complete", "2026-10-02T01:00:00.000Z")]);
  const result = mergeJobPage(current, {
    ...page([job("a", "running"), job("b", "complete")]),
    warnings: ["Corrupt job"],
    page: { limit: 25, scanned: 2, nextCursor: "more" },
  });
  assert.equal(result.jobs.length, 2);
  assert.equal(result.jobs.find((item) => item.id === "a")?.status, "complete");
  assert.equal(result.page?.nextCursor, "more");
  assert.equal(current.jobs.length, 1);
  assert.equal(
    mergeJobs(current.jobs, [
      job("a", "cancelled", "2026-10-02T02:00:00.000Z"),
    ])[0].status,
    "cancelled",
  );
});

test("active jobs pruned from reservations between polls receive a direct fresh status", async () => {
  const reads: string[] = [];
  const snapshot = {
    ...page([job("new", "running")]),
    reservations: { known: true, count: 1 },
  };
  const result = await refreshUntrackedJobs(
    [job("old", "running"), job("finished", "complete")],
    snapshot,
    async (id) => {
      reads.push(id);
      return job(id, "complete", "2026-10-02T02:00:00.000Z");
    },
  );
  assert.deepEqual(reads, ["old"]);
  assert.equal(
    result.jobs.find((item) => item.id === "old")?.status,
    "complete",
  );
  assert.equal(result.jobs.length, 3);
  assert.equal(result.reservations?.known, true);
});

test("failed direct status reads retain last observation and expose uncertainty without SDK detail", async () => {
  const result = await refreshUntrackedJobs(
    [job("old", "running")],
    { ...page([]), reservations: { known: true, count: 0 } },
    async () => {
      throw new Error("token=private");
    },
  );
  assert.equal(result.jobs[0].status, "running");
  assert.equal(result.reservations?.known, false);
  assert.equal(result.warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /token|private/);
});

test("direct reconciliation does not refetch included jobs and bounds concurrency", async () => {
  let active = 0,
    peak = 0,
    reads = 0;
  const observed = Array.from({ length: 20 }, (_, index) =>
    job(String(index), "running"),
  );
  const result = await refreshUntrackedJobs(
    observed,
    { ...page([observed[0]]), reservations: { known: true, count: 1 } },
    async (id) => {
      active++;
      reads++;
      peak = Math.max(active, peak);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return job(id, "complete");
    },
  );
  assert.equal(reads, 19);
  assert.equal(peak, 8);
  assert.equal(result.jobs.length, 20);
});

test("all actionable and uncertain jobs precede explicitly expandable completed history", () => {
  const jobs = [
    ...Array.from({ length: 20 }, (_, index) =>
      job(`done-${index}`, "complete"),
    ),
    job("active", "running"),
    job("uncertain", "interrupted"),
    job("cancelling", "cancelling"),
  ];
  const first = visibleJobs(jobs, 6);
  assert.deepEqual(
    first.jobs.slice(0, 3).map((item) => item.id),
    ["active", "uncertain", "cancelling"],
  );
  assert.equal(first.jobs.length, 9);
  assert.equal(first.current, 3);
  assert.equal(first.remaining, 14);
  assert.equal(visibleJobs(jobs, 12).remaining, 8);
  assert.equal(visibleJobs(jobs, 100).jobs.length, jobs.length);
});

test("an interrupted job with a still available stop control cannot be collapsed into history", () => {
  const interrupted = {
    ...job("stop-available", "interrupted"),
    controlVersion: 1 as const,
    allocationState: "stopped" as const,
    expiresAt: "2026-10-02T02:00:00.000Z",
  };
  assert.equal(
    visibleJobs(
      [job("done", "complete"), interrupted],
      0,
      Date.parse("2026-10-02T01:00:00.000Z"),
    ).jobs[0].id,
    interrupted.id,
  );
});
