import type { PublicCloudJob } from "./cloud-runner";

type JobStatus = Pick<PublicCloudJob, "id" | "status">;
type PollingSnapshot = {
  jobs: readonly JobStatus[];
  warnings?: readonly string[];
  truncated?: boolean;
};

/** Unknown or incomplete listings cannot establish that the workspace is idle. */
export function jobPollingDelay(snapshot: PollingSnapshot | null): number {
  if (
    !snapshot ||
    snapshot.warnings?.length ||
    snapshot.truncated ||
    snapshot.jobs.some((job) =>
      ["starting", "running", "cancelling"].includes(job.status),
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
