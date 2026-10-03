import { z } from "zod";
import { listKeys, readJSON, writeJSON } from "./cloud-storage";
import { StoreError } from "./store";
import type { CloudJob } from "./cloud-runner";

const LEDGER_KEY = "control/job-admission.json";
const jobId = /^cloud_[a-f0-9]{32}$/;
const ledgerSchema = z
  .object({
    version: z.literal(1),
    reservations: z
      .array(
        z
          .object({
            id: z.string().regex(jobId),
            fingerprint: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .strict(),
      )
      .max(1000)
      .refine(
        (entries) =>
          new Set(entries.map((entry) => entry.id)).size === entries.length,
      ),
  })
  .strict();
type Store = Pick<
  typeof import("./cloud-storage"),
  "readJSON" | "writeJSON" | "listKeys"
>;
type Dependencies = {
  store?: Store;
  getJob: (id: string) => Promise<CloudJob>;
  workerStopped?: (job: CloudJob) => Promise<boolean>;
  env?: Record<string, string | undefined>;
  now?: () => number;
};

export function cloudJobLimit(
  env: Record<string, string | undefined> = process.env,
) {
  const value = env.GAUNTLET_MAX_ACTIVE_JOBS ?? "2";
  if (!/^[1-8]$/.test(value))
    throw new StoreError(
      "Set GAUNTLET_MAX_ACTIVE_JOBS to a whole number from 1 to 8.",
      503,
    );
  return Number(value);
}

async function readAdmissionLedger(store: Pick<Store, "readJSON">) {
  const saved = await store.readJSON<unknown>(LEDGER_KEY);
  if (!saved) return null;
  const parsed = ledgerSchema.safeParse(saved.value);
  if (!parsed.success)
    throw new StoreError(
      "Workspace execution capacity cannot be verified. Repair the admission record before launching another evaluation.",
      503,
    );
  return { value: parsed.data, etag: saved.etag };
}

/** Read-only visibility, never admission or provider reconciliation. Null means unknown. */
export async function readCloudJobReservations(
  store: Pick<Store, "readJSON"> = { readJSON },
): Promise<string[] | null> {
  const ledger = await readAdmissionLedger(store);
  return ledger ? ledger.value.reservations.map(({ id }) => id) : null;
}

/** A single CAS record serializes admission across server instances; it never relies on a partial job listing. */
export function createCloudAdmission(dependencies: Dependencies) {
  const store = dependencies.store ?? { readJSON, writeJSON, listKeys };
  const now = dependencies.now ?? Date.now;

  async function occupiesSlot(id: string): Promise<boolean> {
    let job: CloudJob;
    try {
      job = await dependencies.getJob(id);
    } catch {
      return true;
    } // Missing/corrupt data is not proof that an allocation stopped.
    if (
      job.status === "complete" ||
      job.status === "cancelled" ||
      job.allocationState === "stopped"
    )
      return false;
    if (
      job.status === "failed" &&
      (Number.isInteger(job.exitCode) || job.allocationState === "pending")
    )
      return false;
    const uncertain =
      job.status === "interrupted" ||
      job.status === "failed" ||
      Date.parse(job.expiresAt) <= now();
    if (uncertain && dependencies.workerStopped) {
      try {
        if (await dependencies.workerStopped(job)) return false;
      } catch {
        /* Provider failure or not-found is uncertainty, never a free slot. */
      }
    }
    return true;
  }

  async function readLedger() {
    return readAdmissionLedger(store);
  }

  async function initialize() {
    if (await readLedger()) return;
    const listing = await store.listKeys("jobs/", 1000);
    if (listing.truncated || listing.keys.length > 1000)
      throw new StoreError(
        "Existing execution history is too large to establish safe capacity. Migrate the admission record before launching another evaluation.",
        503,
      );
    const ids = listing.keys.map(
      (key) => /^jobs\/(cloud_[a-f0-9]{32})\.json$/.exec(key)?.[1],
    );
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
      throw new StoreError(
        "Existing execution records cannot be reconciled safely. Inspect cloud job storage before launching another evaluation.",
        503,
      );
    const activeIds: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 8) {
      const batch = ids.slice(offset, offset + 8) as string[];
      const active = await Promise.all(batch.map(occupiesSlot));
      batch.forEach((id, index) => {
        if (active[index]) activeIds.push(id);
      });
    }
    try {
      await store.writeJSON(
        LEDGER_KEY,
        { version: 1, reservations: activeIds.map((id) => ({ id })) },
        null,
      );
    } catch (error) {
      if (!(error instanceof StoreError) || error.status !== 409) throw error;
      if (!(await readLedger()))
        throw new StoreError(
          "Workspace capacity changed. Retry with the same idempotency key.",
          503,
        );
    }
  }

  async function admit(id: string, fingerprint: string) {
    if (!jobId.test(id))
      throw new StoreError("Invalid cloud job identity", 400);
    if (!/^[a-f0-9]{64}$/.test(fingerprint))
      throw new StoreError("Invalid execution fingerprint", 400);
    const limit = cloudJobLimit(dependencies.env);
    for (let attempt = 0; attempt < 16; attempt++) {
      const saved = await readLedger();
      if (!saved)
        throw new StoreError(
          "Workspace capacity is unavailable. Retry with the same idempotency key.",
          503,
        );
      const existing = saved.value.reservations.find(
        (entry) => entry.id === id,
      );
      if (existing) {
        if (existing.fingerprint && existing.fingerprint !== fingerprint)
          throw new StoreError(
            "This idempotency key belongs to a different evaluation plan. Use a new key for a new evaluation.",
            409,
          );
        return;
      }
      const occupied = await Promise.all(
        saved.value.reservations.map((entry) => occupiesSlot(entry.id)),
      );
      const reservations = saved.value.reservations.filter(
        (_, index) => occupied[index],
      );
      if (reservations.length >= limit)
        throw new StoreError(
          `Workspace capacity is full (${reservations.length}/${limit} evaluations). No job was created. Retry with the same idempotency key after completion or cancellation acknowledgment. Unconfirmed workers retain capacity until the provider confirms they stopped.`,
          429,
        );
      try {
        await store.writeJSON(
          LEDGER_KEY,
          { version: 1, reservations: [...reservations, { id, fingerprint }] },
          saved.etag,
        );
        return;
      } catch (error) {
        if (!(error instanceof StoreError) || error.status !== 409) throw error;
      }
    }
    throw new StoreError(
      "Workspace capacity changed repeatedly. Retry with the same idempotency key before creating another attempt.",
      409,
    );
  }

  return { initialize, admit };
}
