import { getPublicCloudJob, type PublicCloudJob } from "./cloud-runner";
import { listKeys } from "./cloud-storage";
import { StoreError } from "./store";

type Dependencies = {
  listKeys: typeof listKeys;
  getPublicCloudJob: typeof getPublicCloudJob;
};
export type CloudJobList = {
  jobs: PublicCloudJob[];
  warnings: string[];
  truncated: boolean;
};
const defaults: Dependencies = { listKeys, getPublicCloudJob };

/** Isolate corrupt jobs and expiry-reconciliation failures from the rest of the library. */
export async function listCloudJobs(
  deps: Dependencies = defaults,
): Promise<CloudJobList> {
  let listing: Awaited<ReturnType<typeof listKeys>>;
  try {
    listing = await deps.listKeys("jobs/", 200);
  } catch {
    throw new StoreError(
      "Execution jobs could not be listed. Refresh before starting another attempt.",
      503,
    );
  }
  const jobs: PublicCloudJob[] = [];
  const warnings: string[] = [];
  const ids: string[] = [];
  let skipped = 0;
  for (const key of listing.keys.slice(0, 200)) {
    const match = /^jobs\/(cloud_[a-f0-9]{32})\.json$/.exec(key);
    if (!match || ids.includes(match[1])) {
      skipped++;
      continue;
    }
    ids.push(match[1]);
  }
  if (skipped)
    warnings.push(
      `${skipped} invalid or duplicate job entries were skipped. Stored data is unchanged.`,
    );
  for (let offset = 0; offset < ids.length; offset += 8) {
    const batch = ids.slice(offset, offset + 8);
    const outcomes = await Promise.allSettled(
      batch.map((id) => deps.getPublicCloudJob(id)),
    );
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") jobs.push(outcome.value);
      else
        warnings.push(
          `${batch[index]}: job status is unavailable. Saved evidence is unchanged; refresh before starting another attempt.`,
        );
    });
  }
  jobs.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
  return {
    jobs,
    warnings,
    truncated: listing.truncated || listing.keys.length > 200,
  };
}
