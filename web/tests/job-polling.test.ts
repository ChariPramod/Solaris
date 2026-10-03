import test from "node:test";
import assert from "node:assert/strict";
import { jobLibrarySignature, jobPollingDelay } from "../lib/job-polling";

test("active execution and cancellation remain responsive; a complete idle listing reduces requests", () => {
  for (const status of ["starting", "running", "cancelling"] as const)
    assert.equal(jobPollingDelay({ jobs: [{ id: "active", status }] }), 10_000);

  assert.equal(jobPollingDelay({ jobs: [] }), 60_000);
  assert.equal(
    jobPollingDelay({
      jobs: ["complete", "failed", "cancelled", "interrupted"].map(
        (status) => ({
          id: status,
          allocationState: "stopped" as const,
          status: status as "complete" | "failed" | "cancelled" | "interrupted",
        }),
      ),
    }),
    60_000,
  );
});

test("an unknown or partial listing cannot silently switch to idle polling", () => {
  assert.equal(jobPollingDelay(null), 10_000);
  assert.equal(
    jobPollingDelay({ jobs: [], reservations: { known: false, count: null } }),
    10_000,
  );
  for (const status of ["interrupted", "failed"] as const) {
    assert.equal(
      jobPollingDelay({ jobs: [{ id: "uncertain", status }] }),
      10_000,
    );
  }
  assert.equal(
    jobPollingDelay({ jobs: [], warnings: ["Unreadable job"] }),
    10_000,
  );
  assert.equal(jobPollingDelay({ jobs: [], truncated: true }), 10_000);
  assert.equal(
    jobPollingDelay({ jobs: [], warnings: [], truncated: false }),
    60_000,
  );
});

test("library invalidation ignores heartbeat metadata and ordering but tracks job identity and lifecycle", () => {
  const jobs = [
    { id: "a", status: "running" as const, updatedAt: "before" },
    { id: "b", status: "complete" as const, updatedAt: "before" },
  ];
  const signature = jobLibrarySignature(jobs);
  assert.equal(
    signature,
    jobLibrarySignature(
      jobs.toReversed().map((job) => ({ ...job, updatedAt: "after" })),
    ),
  );
  assert.notEqual(
    signature,
    jobLibrarySignature([{ ...jobs[0], status: "complete" }, jobs[1]]),
  );
  assert.notEqual(
    signature,
    jobLibrarySignature([...jobs, { id: "c", status: "starting" }]),
  );
  assert.notEqual(signature, jobLibrarySignature(jobs.slice(0, 1)));
  assert.notEqual(
    signature,
    jobLibrarySignature([{ ...jobs[0], id: "new-attempt" }, jobs[1]]),
  );
});
