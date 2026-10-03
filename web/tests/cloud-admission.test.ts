import test from "node:test";
import assert from "node:assert/strict";
import {
  createCloudAdmission,
  cloudJobLimit,
  readCloudJobReservations,
} from "../lib/cloud-admission";
import type { CloudJob } from "../lib/cloud-runner";
import { StoreError } from "../lib/store";

const id = (n: number) => `cloud_${n.toString(16).padStart(32, "0")}`;
const fingerprint = "a".repeat(64);
function fixture(options: { truncated?: boolean; unavailable?: boolean } = {}) {
  const data = new Map<string, { value: unknown; etag: string }>();
  const jobs = new Map<string, CloudJob>();
  const store = {
    async readJSON<T>(key: string) {
      if (options.unavailable) throw new StoreError("Unavailable", 503);
      const saved = data.get(key);
      return saved
        ? { value: structuredClone(saved.value) as T, etag: saved.etag }
        : null;
    },
    async writeJSON(key: string, value: unknown, expected: string | null) {
      if ((data.get(key)?.etag ?? null) !== expected)
        throw new StoreError("Conflict", 409);
      const etag = String(Number(expected ?? "0") + 1);
      data.set(key, { value: structuredClone(value), etag });
      return { etag };
    },
    async listKeys() {
      return {
        keys: [...jobs.keys()].map((job) => `jobs/${job}.json`),
        truncated: options.truncated ?? false,
      };
    },
  };
  const admission = createCloudAdmission({
    store,
    getJob: async (jobId) => {
      const job = jobs.get(jobId);
      if (!job) throw new StoreError("Missing", 404);
      return job;
    },
    env: { GAUNTLET_MAX_ACTIVE_JOBS: "1" },
    workerStopped: async () => {
      throw new Error("Provider unavailable");
    },
  });
  const add = (
    n: number,
    status: CloudJob["status"],
    extra: Partial<CloudJob> = {},
  ) => {
    jobs.set(id(n), {
      id: id(n),
      status,
      expiresAt: "2000-01-01T00:00:00.000Z",
      ...extra,
    } as CloudJob);
  };
  return { data, jobs, admission, add };
}

test("first admission accounts for legacy active jobs and never infers expiry means stopped", async () => {
  const f = fixture();
  f.add(1, "running");
  await f.admission.initialize();
  await assert.rejects(
    f.admission.admit(id(2), fingerprint),
    (error: unknown) => error instanceof StoreError && error.status === 429,
  );
  f.add(1, "interrupted");
  await assert.rejects(
    f.admission.admit(id(2), fingerprint),
    (error: unknown) => error instanceof StoreError && error.status === 429,
  );
});

test("truncated bootstrap and unavailable storage fail closed without inventing an empty ledger", async () => {
  for (const options of [{ truncated: true }, { unavailable: true }]) {
    const f = fixture(options);
    await assert.rejects(
      f.admission.initialize(),
      (error: unknown) => error instanceof StoreError && error.status === 503,
    );
    assert.equal(f.data.size, 0);
  }
});

test("missing reserved jobs retain capacity while their same-key reservation remains recoverable", async () => {
  const f = fixture();
  await f.admission.initialize();
  await f.admission.admit(id(1), fingerprint);
  await f.admission.admit(id(1), fingerprint);
  await assert.rejects(
    f.admission.admit(id(1), "b".repeat(64)),
    (error: unknown) => error instanceof StoreError && error.status === 409,
  );
  await assert.rejects(
    f.admission.admit(id(2), fingerprint),
    (error: unknown) => error instanceof StoreError && error.status === 429,
  );
});

test("authoritative completion, cancellation and failed subprocess release reservations", async () => {
  for (const [status, extra] of [
    ["complete", {}],
    ["cancelled", {}],
    ["failed", { exitCode: 2 }],
    ["failed", { allocationState: "stopped" }],
    ["failed", { allocationState: "pending" }],
  ] as [CloudJob["status"], Partial<CloudJob>][]) {
    const f = fixture();
    await f.admission.initialize();
    await f.admission.admit(id(1), fingerprint);
    f.add(1, status, extra);
    await f.admission.admit(id(2), fingerprint);
    const ledger = [...f.data.values()][0].value as {
      reservations: { id: string }[];
    };
    assert.deepEqual(
      ledger.reservations.map((entry) => entry.id),
      [id(2)],
    );
  }
});

test("preparation failures with ambiguous provider allocation do not release capacity", async () => {
  const f = fixture();
  f.add(1, "failed", { allocationState: "provisioning" });
  await f.admission.initialize();
  await assert.rejects(
    f.admission.admit(id(2), fingerprint),
    (error: unknown) => error instanceof StoreError && error.status === 429,
  );
});

test("malformed admission state fails closed and limit configuration is bounded", async () => {
  const f = fixture();
  f.data.set("control/job-admission.json", {
    value: { version: 1, reservations: [{ id: "bad" }] },
    etag: "1",
  });
  await assert.rejects(f.admission.initialize(), /cannot be verified/);
  assert.equal(cloudJobLimit({}), 2);
  assert.equal(cloudJobLimit({ GAUNTLET_MAX_ACTIVE_JOBS: "8" }), 8);
  for (const value of ["0", "9", "2.0", "-1", "invalid"])
    assert.throws(() => cloudJobLimit({ GAUNTLET_MAX_ACTIVE_JOBS: value }));
});

test("reservation visibility validates durable identities and never changes admission state", async () => {
  const calls: string[] = [];
  const saved = { version: 1, reservations: [{ id: id(1), fingerprint }] };
  const result = await readCloudJobReservations({
    readJSON: async <T>(key: string) => {
      calls.push(key);
      return { value: saved as T, etag: "1" };
    },
  });
  assert.deepEqual(result, [id(1)]);
  assert.deepEqual(calls, ["control/job-admission.json"]);
  assert.equal(
    await readCloudJobReservations({ readJSON: async () => null }),
    null,
  );
  await assert.rejects(
    readCloudJobReservations({
      readJSON: async <T>() => ({
        value: {
          version: 1,
          reservations: [{ id: id(1) }, { id: id(1) }],
        } as T,
        etag: "1",
      }),
    }),
    /cannot be verified/,
  );
  assert.deepEqual(saved, {
    version: 1,
    reservations: [{ id: id(1), fingerprint }],
  });
});
