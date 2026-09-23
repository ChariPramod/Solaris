import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  CLOUD_JOB_ID,
  getCloudJob,
  updateCloudJob,
  type CloudJob,
} from "./cloud-runner";
import { ingestArtifact, readCloudRun } from "./cloud-artifacts";
import { recordAttempt } from "./cloud-workspace-data";
import { body, failure, json } from "./http";
import { StoreError } from "./store";

const identity = {
  jobId: z.string().regex(CLOUD_JOB_ID),
  token: z.string().regex(/^[a-f0-9]{64}$/),
};
const artifact = z
  .object({
    ...identity,
    path: z
      .string()
      .regex(
        /^(?:results\.json|audit\.json|T(?:0[1-9]|1[0-2])\/[1-3]\/(?:task\.json|result\.json|lifecycle\.jsonl|actions\.jsonl|\d{3,6}\.jpg|final\.jpg))$/,
      ),
    contentBase64: z
      .string()
      .max(2_796_204)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
const completion = z
  .object({
    ...identity,
    complete: z.literal(true),
    exitCode: z.number().int().min(-255).max(255),
    error: z.string().max(1000).optional(),
    cancelled: z.literal(true).optional(),
  })
  .strict();
const control = z.object({ ...identity, control: z.literal(true) }).strict();
const schema = z.union([artifact, completion, control]);
const terminal = (job: CloudJob) =>
  job.status === "complete" ||
  job.status === "failed" ||
  job.status === "cancelled";

type Dependencies = {
  getJob?: typeof getCloudJob;
  updateJob?: typeof updateCloudJob;
  ingest?: typeof ingestArtifact;
  readRun?: typeof readCloudRun;
  linkAttempt?: typeof recordAttempt;
  scheduleStop?: (name: string) => void;
  now?: () => number;
};

/** Per-job credentials authorize ingestion only; they grant no application read access. */
export function createIngestHandler(dependencies: Dependencies = {}) {
  const getJob = dependencies.getJob ?? getCloudJob;
  const updateJob = dependencies.updateJob ?? updateCloudJob;
  const ingest = dependencies.ingest ?? ingestArtifact;
  const readRun = dependencies.readRun ?? readCloudRun;
  const linkAttempt = dependencies.linkAttempt ?? recordAttempt;
  const now = dependencies.now ?? Date.now;
  return async function POST(request: Request) {
    try {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new StoreError("Expected a JSON upload", 415);
      const input = schema.parse(await body(request, 3 * 1024 * 1024));
      const job = await getJob(input.jobId);
      const actual = Buffer.from(input.token, "hex");
      const expected = Buffer.from(job.callbackToken, "hex");
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new StoreError("Invalid upload credential", 403);
      if ("complete" in input && terminal(job)) return json({ ok: true });
      if (terminal(job))
        throw new StoreError("Completed evidence cannot be changed", 409);
      if (Date.parse(job.expiresAt) <= now())
        throw new StoreError("The upload window has expired", 410);

      if ("control" in input)
        return json({ cancelRequested: Boolean(job.cancelRequestedAt) });

      if (!("complete" in input)) {
        const bytes = Buffer.from(input.contentBase64, "base64");
        if (bytes.length > 2 * 1024 * 1024)
          throw new StoreError("Artifact exceeds upload limit", 413);
        if (bytes.toString("base64") !== input.contentBase64)
          throw new StoreError("Invalid artifact encoding", 400);
        if (input.path === "results.json") {
          let manifest: Record<string, unknown>;
          try {
            manifest = JSON.parse(bytes.toString("utf8"));
          } catch {
            throw new StoreError("Invalid manifest JSON", 400);
          }
          if (
            !manifest ||
            manifest.mode !== job.mode ||
            manifest.trials_per_task !== job.setup.trials ||
            manifest.planned_trials !==
              job.setup.tasks.length * job.setup.trials ||
            !Array.isArray(manifest.task_ids) ||
            JSON.stringify([...manifest.task_ids].sort()) !==
              JSON.stringify([...job.setup.tasks].sort())
          )
            throw new StoreError(
              "Manifest does not match its execution job",
              400,
            );
        } else if (input.path.startsWith("T")) {
          const [task, trial] = input.path.split("/");
          if (
            !job.setup.tasks.includes(task) ||
            Number(trial) > job.setup.trials
          )
            throw new StoreError("Artifact is outside the execution plan", 400);
        }
        await ingest(job.id, input.path, bytes);
        if (input.path === "results.json") await readRun(job.id);
        return json({ ok: true });
      }

      let error = input.error;
      if (input.cancelled && !job.cancelRequestedAt)
        throw new StoreError(
          "Cancellation was not requested for this job",
          409,
        );
      let manifestAvailable = false;
      try {
        await readRun(job.id);
        manifestAvailable = true;
      } catch {
        error =
          error ||
          (input.cancelled
            ? "Cancellation acknowledged without a readable manifest. No task outcome or desktop cleanup is inferred."
            : "Worker ended without a readable manifest; inspect its saved evidence.");
      }
      if (manifestAvailable && job.parentId) {
        try {
          await linkAttempt(job.parentId, job.id);
        } catch {
          error =
            error ||
            "Evaluation evidence was saved, but linking its parent attempt failed.";
        }
      }
      const finished = await updateJob(job.id, (current) => {
        if (terminal(current)) return current;
        return {
          ...current,
          status: input.cancelled
            ? "cancelled"
            : error || ![0, 3].includes(input.exitCode)
              ? "failed"
              : "complete",
          exitCode: input.exitCode,
          ...(error ? { error } : { error: undefined }),
        };
      });
      if (finished.sandboxId) dependencies.scheduleStop?.(finished.sandboxId);
      return json({ ok: true });
    } catch (error) {
      return failure(error);
    }
  };
}
