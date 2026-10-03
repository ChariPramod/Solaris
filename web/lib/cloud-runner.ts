import { createHash, randomBytes } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { z } from "zod";
import { listKeys, readJSON, writeJSON } from "./cloud-storage";
import { cloudJobLimit, createCloudAdmission } from "./cloud-admission";
import { setupSchema } from "./harness";
import { StoreError } from "./store";
import type { RunSetup } from "./types";

export type CloudJob = {
  id: string;
  mode: "dry-run" | "live";
  setup: RunSetup;
  parentId?: string;
  status:
    | "starting"
    | "running"
    | "cancelling"
    | "cancelled"
    | "complete"
    | "failed"
    | "interrupted";
  controlVersion?: 1;
  cancelRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  callbackToken: string;
  sourceRevision: string;
  sandboxId?: string;
  sessionId?: string;
  commandId?: string;
  exitCode?: number | null;
  error?: string;
  requestFingerprint?: string;
  allocationState?:
    "pending" | "provisioning" | "allocated" | "launching" | "stopped";
};
export type PublicCloudJob = Omit<
  CloudJob,
  "callbackToken" | "requestFingerprint"
>;
export const CLOUD_JOB_ID = /^cloud_[a-f0-9]{32}$/;
const ACTIVE = new Set(["starting", "running", "cancelling"]);
const MAX_WALL_MS = 45 * 60 * 1000;
const jobSchema = z
  .object({
    id: z.string().regex(CLOUD_JOB_ID),
    mode: z.enum(["dry-run", "live"]),
    setup: setupSchema,
    parentId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/)
      .optional(),
    status: z.enum([
      "starting",
      "running",
      "cancelling",
      "cancelled",
      "complete",
      "failed",
      "interrupted",
    ]),
    controlVersion: z.literal(1).optional(),
    cancelRequestedAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    callbackToken: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRevision: z.string().regex(/^[a-fA-F0-9]{40}$/),
    sandboxId: z.string().min(1).max(200).optional(),
    sessionId: z.string().min(1).max(200).optional(),
    commandId: z.string().min(1).max(200).optional(),
    exitCode: z.number().int().min(-255).max(255).nullable().optional(),
    error: z.string().max(2000).optional(),
    requestFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    allocationState: z
      .enum(["pending", "provisioning", "allocated", "launching", "stopped"])
      .optional(),
  })
  .strict();

function validatedJob(value: unknown, id: string): CloudJob {
  const parsed = jobSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== id)
    throw new StoreError(
      "Cloud job data is invalid. Saved evidence is preserved.",
      503,
    );
  return parsed.data;
}

export function publicCloudJob(job: CloudJob): PublicCloudJob {
  const {
    callbackToken: _token,
    requestFingerprint: _fingerprint,
    ...result
  } = job;
  return result;
}

type Store = {
  readJSON: typeof readJSON;
  writeJSON: typeof writeJSON;
  listKeys: typeof listKeys;
};
type SandboxInstance = Pick<
  Sandbox,
  "name" | "currentSession" | "runCommand" | "stop"
>;
type RunnerDependencies = {
  store?: Store;
  createSandbox?: (
    options: Parameters<typeof Sandbox.create>[0],
  ) => Promise<SandboxInstance>;
  env?: Record<string, string | undefined>;
  now?: () => number;
  workerStopped?: (job: CloudJob) => Promise<boolean>;
};

/** Durable state surrounds the single detached execution; storage retries never rerun a job. */
export function createCloudRunner(dependencies: RunnerDependencies = {}) {
  const store = dependencies.store ?? { readJSON, writeJSON, listKeys };
  const createSandbox =
    dependencies.createSandbox ?? ((options) => Sandbox.create(options));
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? Date.now;
  const timestamp = () => new Date(now()).toISOString();
  const admission = createCloudAdmission({
    store,
    getJob: getCloudJob,
    env,
    now,
    workerStopped:
      dependencies.workerStopped ??
      (async (job) => {
        const sandbox = await Sandbox.get({
          name: job.sandboxId ?? job.id.replaceAll("_", "-"),
          resume: false,
          signal: AbortSignal.timeout(10_000),
        });
        return ["stopped", "failed", "aborted"].includes(sandbox.status);
      }),
  });

  async function getCloudJob(id: string): Promise<CloudJob> {
    if (!CLOUD_JOB_ID.test(id))
      throw new StoreError("Invalid cloud job identity", 400);
    const saved = await store.readJSON<CloudJob>(`jobs/${id}.json`);
    if (!saved) throw new StoreError("Cloud job was not found", 404);
    return validatedJob(saved.value, id);
  }

  async function updateCloudJob(
    id: string,
    change: (job: CloudJob) => CloudJob,
  ) {
    if (!CLOUD_JOB_ID.test(id))
      throw new StoreError("Invalid cloud job identity", 400);
    for (let attempt = 0; attempt < 4; attempt++) {
      const saved = await store.readJSON<CloudJob>(`jobs/${id}.json`);
      if (!saved) throw new StoreError("Cloud job was not found", 404);
      const next = validatedJob(
        { ...change(validatedJob(saved.value, id)), updatedAt: timestamp() },
        id,
      );
      try {
        await store.writeJSON(`jobs/${id}.json`, next, saved.etag);
        return next;
      } catch (error) {
        if (
          !(error instanceof StoreError) ||
          error.status !== 409 ||
          attempt === 3
        )
          throw error;
      }
    }
    throw new StoreError("Cloud job changed; refresh its status", 409);
  }

  async function getPublicCloudJob(id: string): Promise<PublicCloudJob> {
    let job = await getCloudJob(id);
    if (ACTIVE.has(job.status) && Date.parse(job.expiresAt) < now()) {
      job = await updateCloudJob(id, (current) =>
        ACTIVE.has(current.status)
          ? {
              ...current,
              status: "interrupted",
              error:
                "The worker stopped reporting before its time limit. Inspect saved evidence and cleanup records before creating another attempt.",
            }
          : current,
      );
    }
    return publicCloudJob(job);
  }

  async function cancelCloudJob(id: string): Promise<PublicCloudJob> {
    return publicCloudJob(
      await updateCloudJob(id, (job) => {
        if (["complete", "failed", "cancelled"].includes(job.status))
          return job;
        if (Date.parse(job.expiresAt) <= now())
          throw new StoreError(
            "The worker window has expired. Inspect saved cleanup records; stopping remote desktops is not confirmed.",
            409,
          );
        if (job.controlVersion !== 1)
          throw new StoreError(
            "This older worker does not support cancellation. Inspect its evidence and wait for its execution limit.",
            409,
          );
        return {
          ...job,
          status: "cancelling",
          cancelRequestedAt: job.cancelRequestedAt ?? timestamp(),
        };
      }),
    );
  }

  async function startCloudRun(
    raw: RunSetup,
    mode: "dry-run" | "live",
    origin: string,
    parentId?: string,
    idempotencyKey?: string,
  ) {
    const setup = setupSchema.parse(raw);
    if (!["dry-run", "live"].includes(mode))
      throw new StoreError("Invalid run mode", 400);
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new StoreError(
        "Cloud execution needs the canonical HTTPS application origin",
        503,
      );
    if (parentId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(parentId))
      throw new StoreError("Invalid parent experiment", 400);
    if (
      idempotencyKey !== undefined &&
      !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)
    )
      throw new StoreError(
        "Idempotency-Key must contain 16 to 128 letters, numbers, dots, colons, underscores or hyphens.",
        400,
      );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          setup: { ...setup, tasks: [...setup.tasks].sort() },
          mode,
          parentId: parentId ?? null,
        }),
      )
      .digest("hex");
    const id = idempotencyKey
      ? `cloud_${createHash("sha256").update(`solaris-execution-v1:${idempotencyKey}`).digest("hex").slice(0, 32)}`
      : `cloud_${randomBytes(16).toString("hex")}`;
    const existing = await store.readJSON<CloudJob>(`jobs/${id}.json`);
    if (existing) {
      const job = validatedJob(existing.value, id);
      if (job.requestFingerprint !== fingerprint)
        throw new StoreError(
          "This idempotency key belongs to a different evaluation plan. Use a new key for a new evaluation.",
          409,
        );
      return publicCloudJob(job);
    }
    const revision = env.GAUNTLET_SOURCE_REVISION || env.VERCEL_GIT_COMMIT_SHA;
    if (!revision || !/^[a-fA-F0-9]{40}$/.test(revision))
      throw new StoreError(
        "Set GAUNTLET_SOURCE_REVISION to the published source commit before running evaluations",
        503,
      );
    const workerEnv: Record<string, string> = { PYTHONUNBUFFERED: "1" };
    if (mode === "live") {
      const providerKey =
        setup.provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      for (const key of ["SOLARI_API_KEY", providerKey]) {
        if (!env[key]?.trim())
          throw new StoreError(
            `Configure ${key} in the server environment before starting a live evaluation`,
            503,
          );
        workerEnv[key] = env[key]!;
      }
      if (setup.provider === "openai" && !setup.modelId)
        throw new StoreError(
          "Select an OpenAI model before starting a live evaluation",
          400,
        );
    }
    cloudJobLimit(env);
    await admission.initialize();
    // Reserve before creating the job: a capacity rejection consumes no key and creates no failed job.
    await admission.admit(id, fingerprint);
    const createdAt = timestamp();
    const initial: CloudJob = {
      id,
      mode,
      setup,
      ...(parentId ? { parentId } : {}),
      status: "starting",
      controlVersion: 1,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(now() + MAX_WALL_MS).toISOString(),
      callbackToken: randomBytes(32).toString("hex"),
      sourceRevision: revision,
      requestFingerprint: fingerprint,
      allocationState: "pending",
    };
    try {
      await store.writeJSON(`jobs/${id}.json`, initial, null);
    } catch (error) {
      let winner: CloudJob;
      try {
        winner = await getCloudJob(id);
      } catch {
        throw error;
      }
      if (winner.requestFingerprint !== fingerprint)
        throw new StoreError(
          "This idempotency key belongs to a different evaluation plan. Use a new key for a new evaluation.",
          409,
        );
      if (winner.callbackToken === initial.callbackToken) {
        // Our create may have committed even when its response was lost. Never continue a paid launch.
        winner = await updateCloudJob(id, (job) =>
          job.allocationState === "pending"
            ? {
                ...job,
                status: "failed",
                error:
                  "Job creation was saved but could not be confirmed. No worker was launched. Use a new idempotency key for an intentional new attempt.",
              }
            : job,
        );
      }
      return publicCloudJob(winner);
    }
    let sandbox: SandboxInstance | undefined;
    let provisionAttempted = false;
    let launchAttempted = false;
    try {
      await updateCloudJob(id, (job) => ({
        ...job,
        allocationState: "provisioning",
      }));
      provisionAttempted = true;
      sandbox = await createSandbox({
        name: id.replaceAll("_", "-"),
        source: {
          type: "git",
          url: "https://github.com/ChariPramod/Solaris.git",
          revision,
        },
        runtime: "python3.13",
        persistent: false,
        timeout: MAX_WALL_MS,
        resources: { vcpus: 2 },
      });
      await updateCloudJob(id, (job) => ({
        ...job,
        sandboxId: sandbox!.name,
        sessionId: sandbox!.currentSession().sessionId,
        status: job.cancelRequestedAt ? "cancelling" : "running",
        allocationState: "allocated",
      }));
      workerEnv.GAUNTLET_CLOUD_CONFIG = JSON.stringify({
        jobId: id,
        token: initial.callbackToken,
        mode,
        setup,
        callbackUrl: `${url.origin}/api/cloud/ingest`,
        controlVersion: 1,
      });
      await updateCloudJob(id, (job) => ({
        ...job,
        allocationState: "launching",
      }));
      launchAttempted = true;
      const command = await sandbox.runCommand({
        cmd: "python3",
        args: ["-m", "gauntlet.cloud_worker"],
        cwd: "/vercel/sandbox",
        env: workerEnv,
        detached: true,
        timeoutMs: MAX_WALL_MS - 30_000,
      });
      return publicCloudJob(
        await updateCloudJob(id, (job) => ({
          ...job,
          commandId: command.cmdId,
        })),
      );
    } catch {
      // An ambiguous launch response must never trigger another paid execution.
      let stopped = false;
      if (sandbox && !launchAttempted) {
        try {
          await sandbox.stop();
          stopped = true;
        } catch {
          /* An uncertain stop cannot release workspace capacity. */
        }
      }
      return publicCloudJob(
        await updateCloudJob(id, (job) =>
          ACTIVE.has(job.status)
            ? {
                ...job,
                status: launchAttempted ? "interrupted" : "failed",
                ...(stopped
                  ? { allocationState: "stopped" as const }
                  : !provisionAttempted
                    ? { allocationState: "pending" as const }
                    : {}),
                error: launchAttempted
                  ? "Worker launch could not be confirmed. It may still finish; inspect this job before creating another attempt."
                  : "The execution sandbox could not be prepared. No evaluation was launched.",
              }
            : job,
        ),
      );
    }
  }

  return {
    startCloudRun,
    getCloudJob,
    getPublicCloudJob,
    updateCloudJob,
    cancelCloudJob,
  };
}

export const {
  startCloudRun,
  getCloudJob,
  getPublicCloudJob,
  updateCloudJob,
  cancelCloudJob,
} = createCloudRunner();
