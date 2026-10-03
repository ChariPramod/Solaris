import type { CloudJobList } from "./cloud-job-list";
import type { PublicCloudJob } from "./cloud-runner";
import { jobPollingDelay } from "./job-polling";

/** Keep the freshest observation when history and independent status polls race. */
export function mergeJobs(
  current: readonly PublicCloudJob[],
  incoming: readonly PublicCloudJob[],
) {
  const jobs = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) {
    const previous = jobs.get(job.id);
    if (!previous || job.updatedAt >= previous.updatedAt) jobs.set(job.id, job);
  }
  return [...jobs.values()].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
}

export function mergeJobPage(
  current: CloudJobList | null,
  page: CloudJobList,
): CloudJobList {
  return {
    ...page,
    jobs: mergeJobs(current?.jobs ?? [], page.jobs),
    warnings: [...new Set([...(current?.warnings ?? []), ...page.warnings])],
  };
}

/** Reconcile an observed active job even if admission pruned its reservation between polls. */
export async function refreshUntrackedJobs(
  observed: readonly PublicCloudJob[],
  snapshot: CloudJobList,
  readJob: (id: string) => Promise<PublicCloudJob>,
): Promise<CloudJobList> {
  const tracked = new Set(snapshot.jobs.map((job) => job.id));
  const pending = observed.filter(
    (job) =>
      !tracked.has(job.id) && jobPollingDelay({ jobs: [job] }) === 10_000,
  );
  const updates: PublicCloudJob[] = [];
  const warnings = [...snapshot.warnings];
  for (let offset = 0; offset < pending.length; offset += 8) {
    const batch = pending.slice(offset, offset + 8);
    const results = await Promise.allSettled(
      batch.map((job) => readJob(job.id)),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value.id === batch[index].id)
        updates.push(result.value);
      else
        warnings.push(
          `${batch[index].id}: current status could not be refreshed. Its last observed state is retained.`,
        );
    });
  }
  return {
    ...snapshot,
    jobs: mergeJobs(observed, [...snapshot.jobs, ...updates]),
    warnings,
    reservations: snapshot.reservations && {
      ...snapshot.reservations,
      known: snapshot.reservations.known && warnings.length === 0,
    },
  };
}

/** Current or uncertain work remains visible while completed history expands explicitly. */
export function visibleJobs(
  jobs: readonly PublicCloudJob[],
  historyLimit: number,
  now = Date.now(),
) {
  const needsAttention = (job: PublicCloudJob) =>
    jobPollingDelay({ jobs: [job] }) === 10_000 ||
    (job.status === "interrupted" &&
      job.controlVersion === 1 &&
      Date.parse(job.expiresAt) > now);
  const current = jobs.filter(needsAttention);
  const history = jobs.filter((job) => !needsAttention(job));
  return {
    jobs: [...current, ...history.slice(0, historyLimit)],
    remaining: Math.max(0, history.length - historyLimit),
    current: current.length,
  };
}
