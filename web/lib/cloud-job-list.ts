import { getPublicCloudJob, type PublicCloudJob } from "./cloud-runner";
import { listKeys, listKeyPage } from "./cloud-storage";
import { readCloudJobReservations } from "./cloud-admission";
import { StoreError } from "./store";

type Dependencies = {
  listKeys: typeof listKeys;
  listKeyPage?: typeof listKeyPage;
  getPublicCloudJob: typeof getPublicCloudJob;
};
export type CloudJobList = {
  jobs: PublicCloudJob[];
  warnings: string[];
  truncated: boolean;
  page?: { nextCursor: string | null; limit: number; scanned: number };
  reservations?: { known: boolean; count: number | null };
};
const defaults: Dependencies = { listKeys, listKeyPage, getPublicCloudJob };

async function readJobs(ids: string[], getJob: typeof getPublicCloudJob) {
  const jobs: PublicCloudJob[] = [];
  const warnings: string[] = [];
  for (let offset = 0; offset < ids.length; offset += 8) {
    const batch = ids.slice(offset, offset + 8);
    const outcomes = await Promise.allSettled(batch.map((id) => getJob(id)));
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
  return { jobs, warnings };
}

/** Isolate corrupt jobs and expiry-reconciliation failures from the rest of the library. */
export async function listCloudJobs(
  deps: Dependencies = defaults,
  options?: { limit: number; cursor?: string },
): Promise<CloudJobList> {
  let keys: string[];
  let truncated: boolean;
  let page: CloudJobList["page"];
  try {
    if (options) {
      const result = await (deps.listKeyPage ?? listKeyPage)(
        "jobs/",
        options.limit,
        options.cursor,
      );
      keys = result.keys;
      truncated = result.nextCursor !== null;
      page = {
        nextCursor: result.nextCursor,
        limit: options.limit,
        scanned: keys.length,
      };
    } else {
      const result = await deps.listKeys("jobs/", 200);
      keys = result.keys.slice(0, 200);
      truncated = result.truncated || result.keys.length > 200;
    }
  } catch {
    throw new StoreError(
      "Execution jobs could not be listed. Refresh before starting another attempt.",
      503,
    );
  }
  const ids = new Set<string>();
  let skipped = 0;
  for (const key of keys) {
    const match = /^jobs\/(cloud_[a-f0-9]{32})\.json$/.exec(key);
    if (!match || ids.has(match[1])) skipped++;
    else ids.add(match[1]);
  }
  const result = await readJobs([...ids], deps.getPublicCloudJob);
  if (skipped)
    result.warnings.unshift(
      `${skipped} invalid or duplicate job entries were skipped. Stored data is unchanged.`,
    );
  return { ...result, truncated, ...(page ? { page } : {}) };
}

/** Durable reservations keep ongoing work visible independently of archive pagination. */
export async function listReservedCloudJobs(
  deps: {
    readReservations: typeof readCloudJobReservations;
    getPublicCloudJob: typeof getPublicCloudJob;
  } = { readReservations: readCloudJobReservations, getPublicCloudJob },
): Promise<CloudJobList> {
  let ids: string[] | null;
  try {
    ids = await deps.readReservations();
  } catch {
    ids = null;
  }
  if (ids === null)
    return {
      jobs: [],
      warnings: [
        "Current execution tracking is unavailable. Browse job history and refresh before starting another attempt. No capacity or cleanup has been confirmed.",
      ],
      truncated: false,
      reservations: { known: false, count: null },
    };
  const result = await readJobs(ids, deps.getPublicCloudJob);
  return {
    ...result,
    truncated: false,
    reservations: { known: result.warnings.length === 0, count: ids.length },
  };
}
