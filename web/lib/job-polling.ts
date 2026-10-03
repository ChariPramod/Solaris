import type { PublicCloudJob } from "./cloud-runner";

type JobStatus = Pick<PublicCloudJob, "id" | "status"> &
  Partial<Pick<PublicCloudJob, "allocationState" | "exitCode">>;
type PollingSnapshot = {
  jobs: readonly JobStatus[];
  warnings?: readonly string[];
  truncated?: boolean;
  reservations?: { known: boolean; count: number | null };
};

/** Unknown or incomplete listings cannot establish that the workspace is idle. */
export function jobPollingDelay(snapshot: PollingSnapshot | null): number {
  if (
    !snapshot ||
    snapshot.warnings?.length ||
    snapshot.truncated ||
    snapshot.reservations?.known === false ||
    snapshot.jobs.some(
      (job) =>
        ["starting", "running", "cancelling"].includes(job.status) ||
        (job.status === "interrupted" && job.allocationState !== "stopped") ||
        (job.status === "failed" &&
          !Number.isInteger(job.exitCode) &&
          !["stopped", "pending"].includes(job.allocationState ?? "")),
    )
  )
    return 10_000;
  return 60_000;
}

/** Heartbeats and response ordering must not invalidate the evidence library. */
export function jobLibrarySignature(jobs: readonly JobStatus[]): string {
  return JSON.stringify(
    jobs
      .map((job) => [job.id, job.status])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
