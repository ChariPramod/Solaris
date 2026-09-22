import { randomBytes } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { z } from "zod";
import { readJSON, writeJSON } from "./cloud-storage";
import { setupSchema } from "./harness";
import { StoreError } from "./store";
import type { RunSetup } from "./types";

export type CloudJob = {
  id: string;
  mode: "dry-run" | "live";
  setup: RunSetup;
  parentId?: string;
  status: "starting" | "running" | "complete" | "failed" | "interrupted";
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
};
export type PublicCloudJob = Omit<CloudJob, "callbackToken">;
export const CLOUD_JOB_ID = /^cloud_[a-f0-9]{32}$/;
const ACTIVE = new Set(["starting", "running"]);
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
      "complete",
      "failed",
      "interrupted",
    ]),
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
  const { callbackToken: _token, ...result } = job;
  return result;
}

type Store = { readJSON: typeof readJSON; writeJSON: typeof writeJSON };
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
};

/** Durable state surrounds the single detached execution; storage retries never rerun a job. */
export function createCloudRunner(dependencies: RunnerDependencies = {}) {
  const store = dependencies.store ?? { readJSON, writeJSON };
  const createSandbox =
    dependencies.createSandbox ?? ((options) => Sandbox.create(options));
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? Date.now;
  const timestamp = () => new Date(now()).toISOString();

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

  async function startCloudRun(
    raw: RunSetup,
    mode: "dry-run" | "live",
    origin: string,
    parentId?: string,
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
        if (!env[key])
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
    const id = `cloud_${randomBytes(16).toString("hex")}`;
    const createdAt = timestamp();
    const initial: CloudJob = {
      id,
      mode,
      setup,
      ...(parentId ? { parentId } : {}),
      status: "starting",
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(now() + MAX_WALL_MS).toISOString(),
      callbackToken: randomBytes(32).toString("hex"),
      sourceRevision: revision,
    };
    await store.writeJSON(`jobs/${id}.json`, initial, null);
    let sandbox: SandboxInstance | undefined;
    let launchAttempted = false;
    try {
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
        status: "running",
      }));
      workerEnv.GAUNTLET_CLOUD_CONFIG = JSON.stringify({
        jobId: id,
        token: initial.callbackToken,
        mode,
        setup,
        callbackUrl: `${url.origin}/api/cloud/ingest`,
      });
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
      if (sandbox && !launchAttempted)
        await sandbox.stop().catch(() => undefined);
      return publicCloudJob(
        await updateCloudJob(id, (job) =>
          ACTIVE.has(job.status)
            ? {
                ...job,
                status: launchAttempted ? "interrupted" : "failed",
                error: launchAttempted
                  ? "Worker launch could not be confirmed. It may still finish; inspect this job before creating another attempt."
                  : "The execution sandbox could not be prepared. No evaluation was launched.",
              }
            : job,
        ),
      );
    }
  }

  return { startCloudRun, getCloudJob, getPublicCloudJob, updateCloudJob };
}

export const { startCloudRun, getCloudJob, getPublicCloudJob, updateCloudJob } =
  createCloudRunner();
