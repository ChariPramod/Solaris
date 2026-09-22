/** Local workspace metadata. Original benchmark evidence is always read-only. */
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { setupSchema } from "./harness";
import { PROJECT_ROOT, readRun, safeFile, StoreError, validId } from "./store";

export type WorkspaceOptions = { projectRoot?: string; lockTimeoutMs?: number };
const revision = z.number().int().min(0).max(100);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewInputSchema = z
  .object({
    revision,
    evidenceDigest: digest,
    verdict: z.enum([
      "unreviewed",
      "confirmed",
      "needs-investigation",
      "verifier-issue",
    ]),
    category: z.enum(["agent", "environment", "task", "verifier", "uncertain"]),
    note: z.string().max(8000),
    reviewer: z.string().trim().max(120),
  })
  .strict();
const reviewRevisionSchema = reviewInputSchema.extend({
  revision: revision.min(1),
  updatedAt: z.string().datetime(),
});
export type ReviewRevision = z.infer<typeof reviewRevisionSchema>;
export type Review = Omit<ReviewRevision, "updatedAt"> & {
  runId: string;
  taskId: string;
  trial: number;
  updatedAt: string | null;
  stale: boolean;
  currentEvidenceDigest: string;
  history: ReviewRevision[];
};
export const presetInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    revision,
    name: z.string().trim().min(1).max(80),
    setup: setupSchema,
  })
  .strict();
const presetRevisionSchema = presetInputSchema.omit({ id: true }).extend({
  revision: revision.min(1),
  updatedAt: z.string().datetime(),
});
export type PresetRevision = z.infer<typeof presetRevisionSchema>;
const presetSchema = z
  .object({
    id: z.string().uuid(),
    history: z.array(presetRevisionSchema).min(1).max(100),
  })
  .strict();
export type Preset = PresetRevision & { id: string; history: PresetRevision[] };
const presetsSchema = z
  .object({ version: z.literal(1), presets: z.array(presetSchema).max(100) })
  .strict();
const reviewFileSchema = z
  .object({
    version: z.literal(1),
    runId: z.string(),
    taskId: z.string(),
    trial: z.number().int().positive(),
    history: z.array(reviewRevisionSchema).min(1).max(100),
  })
  .strict();
const linkSchema = z
  .object({
    parentId: z.string(),
    childId: z.string(),
    parentRunId: z.string(),
    childRunId: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AttemptLink = z.infer<typeof linkSchema>;
const attemptsSchema = z
  .object({ version: z.literal(1), links: z.array(linkSchema).max(1000) })
  .strict();
const LIMIT = 16 * 1024 * 1024;
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const conflict = (message: string) => new StoreError(message, 409);
function historyValid(history: { revision: number }[]) {
  if (history.some((v, i) => v.revision !== i + 1))
    throw new StoreError(
      "Workspace history is inconsistent. Restore a known-good copy before editing.",
      503,
    );
}
async function location(options: WorkspaceOptions, create = false) {
  const requested = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const project = await lstat(requested);
  if (project.isSymbolicLink() || !project.isDirectory())
    throw new StoreError("Project root must be a real directory.", 503);
  const root = path.join(await realpath(requested), ".gauntlet-workspace");
  if (create)
    await mkdir(root, { mode: 0o700 }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
  try {
    const stat = await lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new StoreError(
        "Workspace metadata folder must be a real directory, not a link or special file.",
        503,
      );
  } catch (e) {
    if (!missing(e)) throw e;
  }
  return root;
}
async function readDocument<T>(
  root: string,
  name: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  try {
    return schema.parse(
      JSON.parse((await safeFile(root, [name], LIMIT)).toString()),
    );
  } catch (e) {
    if (missing(e)) return undefined;
    throw new StoreError(
      "Workspace metadata is unreadable or malformed. Existing evidence is untouched; restore the metadata file before editing.",
      503,
    );
  }
}
async function syncDirectory(root: string) {
  const handle = await open(root, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** A short filesystem lock coordinates writers across processes. Abandoned locks require explicit inspection. */
async function transaction<T>(
  options: WorkspaceOptions,
  action: (root: string) => Promise<T>,
): Promise<T> {
  const root = await location(options, true);
  const lockPath = path.join(root, ".write.lock");
  const timeout = options.lockTimeoutMs ?? 1500;
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 10000)
    throw new StoreError("Invalid workspace lock timeout.");
  const until = Date.now() + timeout;
  let lock;
  for (;;) {
    try {
      lock = await open(
        lockPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST")
        throw new StoreError(
          "Workspace lock could not be created. Check local folder permissions.",
          503,
        );
      if (Date.now() >= until)
        throw new StoreError(
          "Workspace is locked by another writer. Retry; if the server stopped unexpectedly, inspect .gauntlet-workspace/.write.lock and remove it only after all writers have stopped.",
          503,
        );
      await delay(Math.min(25, Math.max(1, until - Date.now())));
    }
  }
  const identity = await lock.stat();
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    await lock.sync();
    return await action(root);
  } finally {
    await lock.close();
    const current = await lstat(lockPath).catch(() => undefined);
    if (current?.ino === identity.ino && current.dev === identity.dev)
      await unlink(lockPath);
  }
}
async function atomicDocument(root: string, name: string, data: unknown) {
  const bytes = Buffer.from(JSON.stringify(data, null, 2) + "\n");
  if (bytes.length > LIMIT)
    throw new StoreError(
      "Workspace metadata reached its size limit. Export and archive it before continuing.",
      409,
    );
  const destination = path.join(root, name);
  const temp = path.join(root, `.tmp-${randomUUID()}`);
  const file = await open(
    temp,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    const existing = await lstat(destination).catch((e) => {
      if (missing(e)) return undefined;
      throw e;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink()))
      throw new StoreError("Workspace destination is not a regular file.", 503);
    await rename(temp, destination);
    await syncDirectory(root);
  } finally {
    await file.close().catch(() => {});
    await unlink(temp).catch(() => {});
  }
}
function reviewName(runId: string, taskId: string, trial: number) {
  return `review-${createHash("sha256")
    .update(JSON.stringify([runId, taskId, trial]))
    .digest("hex")}.json`;
}
async function evidence(
  runId: string,
  taskId: string,
  trial: number,
  options: WorkspaceOptions,
) {
  validId(runId);
  if (!/^T\d{2}$/.test(taskId) || !Number.isSafeInteger(trial) || trial < 1)
    throw new StoreError("Invalid trial identifier.");
  const results = path.join(options.projectRoot ?? PROJECT_ROOT, "results");
  const run = await readRun(runId, results);
  const record = run.records.find(
    (r) => r.task_id === taskId && r.trial === trial,
  );
  if (!record)
    throw new StoreError("No result was recorded for this trial.", 404);
  try {
    const segments = [runId, taskId, String(trial)];
    const result = await safeFile(results, [...segments, "result.json"], LIMIT);
    const task = await safeFile(results, [...segments, "task.json"], LIMIT);
    const saved = JSON.parse(result.toString());
    const snapshot = JSON.parse(task.toString());
    if (
      saved.task_id !== taskId ||
      saved.trial !== trial ||
      snapshot.definition?.id !== taskId
    )
      throw new Error("identity");
    const hash = createHash("sha256");
    for (const bytes of [
      result,
      task,
      Buffer.from(JSON.stringify({ runId: run.run_id ?? null, record })),
    ])
      hash.update(`${bytes.length}:`).update(bytes);
    return hash.digest("hex");
  } catch {
    throw new StoreError(
      "Original trial result or task snapshot is missing, unreadable, or inconsistent. Browse the saved result and audit the run before reviewing.",
      409,
    );
  }
}
async function savedReview(
  root: string,
  runId: string,
  taskId: string,
  trial: number,
) {
  const saved = await readDocument(
    root,
    reviewName(runId, taskId, trial),
    reviewFileSchema,
  );
  if (saved) {
    if (
      saved.runId !== runId ||
      saved.taskId !== taskId ||
      saved.trial !== trial
    )
      throw new StoreError("Workspace review identity is inconsistent.", 503);
    historyValid(saved.history);
  }
  return saved;
}
function reviewView(
  runId: string,
  taskId: string,
  trial: number,
  currentEvidenceDigest: string,
  history: ReviewRevision[],
): Review {
  const latest = history.at(-1) ?? {
    revision: 0,
    evidenceDigest: currentEvidenceDigest,
    verdict: "unreviewed" as const,
    category: "uncertain" as const,
    note: "",
    reviewer: "",
    updatedAt: null,
  };
  return {
    ...latest,
    runId,
    taskId,
    trial,
    currentEvidenceDigest,
    stale: latest.evidenceDigest !== currentEvidenceDigest,
    history,
  };
}
export async function getReview(
  runId: string,
  taskId: string,
  trial: number,
  options: WorkspaceOptions = {},
): Promise<Review> {
  const current = await evidence(runId, taskId, trial, options);
  const saved = await savedReview(
    await location(options),
    runId,
    taskId,
    trial,
  );
  return reviewView(runId, taskId, trial, current, saved?.history ?? []);
}
export async function saveReview(
  runId: string,
  taskId: string,
  trial: number,
  raw: unknown,
  options: WorkspaceOptions = {},
): Promise<Review> {
  const value = reviewInputSchema.parse(raw);
  return transaction(options, async (root) => {
    const current = await evidence(runId, taskId, trial, options);
    const saved = await savedReview(root, runId, taskId, trial);
    const history = saved?.history ?? [];
    if (value.revision !== history.length)
      throw conflict(
        "This review changed in another window. Reload it before saving.",
      );
    if (value.evidenceDigest !== current)
      throw conflict(
        "Evidence changed since you opened this review. Reload and explicitly review the new evidence before saving.",
      );
    if (history.length >= 100)
      throw conflict(
        "Review history reached 100 revisions. Export and archive workspace metadata before continuing.",
      );
    const next = [
      ...history,
      {
        ...value,
        revision: history.length + 1,
        updatedAt: new Date().toISOString(),
      },
    ];
    // Evidence may change while a stopped run is being recovered; verify again before publishing.
    if ((await evidence(runId, taskId, trial, options)) !== current)
      throw conflict("Evidence changed while saving. Reload the review.");
    await atomicDocument(root, reviewName(runId, taskId, trial), {
      version: 1,
      runId,
      taskId,
      trial,
      history: next,
    });
    return reviewView(runId, taskId, trial, current, next);
  });
}
async function presetsDocument(root: string) {
  const data = (await readDocument(root, "presets.json", presetsSchema)) ?? {
    version: 1 as const,
    presets: [],
  };
  if (new Set(data.presets.map((p) => p.id)).size !== data.presets.length)
    throw new StoreError("Workspace preset identities conflict.", 503);
  data.presets.forEach((p) => historyValid(p.history));
  return data;
}
export async function listPresets(
  options: WorkspaceOptions = {},
): Promise<Preset[]> {
  return (await presetsDocument(await location(options))).presets.map((p) => ({
    ...p.history[p.history.length - 1],
    id: p.id,
    history: p.history,
  }));
}
export async function savePreset(
  raw: unknown,
  options: WorkspaceOptions = {},
): Promise<Preset> {
  const value = presetInputSchema.parse(raw);
  return transaction(options, async (root) => {
    const data = await presetsDocument(root);
    const prior = value.id
      ? data.presets.find((p) => p.id === value.id)
      : undefined;
    if ((value.id && !prior) || value.revision !== (prior?.history.length ?? 0))
      throw conflict(
        "This preset changed or was removed. Reload presets before saving.",
      );
    if (!prior && data.presets.length >= 100)
      throw conflict(
        "Workspace supports at most 100 presets. Export and archive metadata before adding more.",
      );
    if ((prior?.history.length ?? 0) >= 100)
      throw conflict(
        "Preset history reached 100 revisions. Export and archive metadata before continuing.",
      );
    const id = prior?.id ?? randomUUID();
    const next = {
      name: value.name,
      setup: value.setup,
      revision: value.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const history = [...(prior?.history ?? []), next];
    if (prior) prior.history = history;
    else data.presets.push({ id, history });
    await atomicDocument(root, "presets.json", data);
    return { ...next, id, history };
  });
}
async function attemptsDocument(root: string) {
  const data = (await readDocument(root, "attempts.json", attemptsSchema)) ?? {
    version: 1 as const,
    links: [],
  };
  const children = new Set<string>();
  for (const link of data.links) {
    validId(link.parentId);
    validId(link.childId);
    if (
      link.parentId === link.childId ||
      link.parentRunId === link.childRunId ||
      children.has(link.childId)
    )
      throw new StoreError("Workspace attempt identities conflict.", 503);
    children.add(link.childId);
  }
  return data;
}
export async function recordAttempt(
  parentId: string,
  childId: string,
  options: WorkspaceOptions = {},
): Promise<AttemptLink> {
  validId(parentId);
  validId(childId);
  if (parentId === childId)
    throw conflict("An attempt must use a new run directory.");
  return transaction(options, async (root) => {
    const results = path.join(options.projectRoot ?? PROJECT_ROOT, "results");
    const [parent, child] = await Promise.all([
      readRun(parentId, results),
      readRun(childId, results),
    ]);
    if (!parent.run_id || !child.run_id || parent.run_id === child.run_id)
      throw conflict(
        "An attempt must have its own recorded run identity; recovered copies are not new attempts.",
      );
    const data = await attemptsDocument(root);
    const existing = data.links.find((l) => l.childId === childId);
    if (existing) {
      if (
        existing.parentId === parentId &&
        existing.parentRunId === parent.run_id &&
        existing.childRunId === child.run_id
      )
        return existing;
      throw conflict("This run is already linked to a different attempt.");
    }
    // A new edge must not introduce a cycle in the existing parent chain.
    let cursor = parentId;
    const visited = new Set<string>();
    while (!visited.has(cursor)) {
      if (cursor === childId)
        throw conflict("Attempt links cannot form a cycle.");
      visited.add(cursor);
      const link = data.links.find((l) => l.childId === cursor);
      if (!link) break;
      cursor = link.parentId;
    }
    if (data.links.length >= 1000)
      throw conflict(
        "Workspace attempt history reached 1,000 links. Export and archive it before continuing.",
      );
    const link = {
      parentId,
      childId,
      parentRunId: parent.run_id,
      childRunId: child.run_id,
      createdAt: new Date().toISOString(),
    };
    data.links.push(link);
    await atomicDocument(root, "attempts.json", data);
    return link;
  });
}
export async function getAttempts(
  runId: string,
  options: WorkspaceOptions = {},
) {
  validId(runId);
  const run = await readRun(
    runId,
    path.join(options.projectRoot ?? PROJECT_ROOT, "results"),
  );
  const data = await attemptsDocument(await location(options));
  return {
    parents: data.links.filter(
      (l) => l.childId === runId && l.childRunId === run.run_id,
    ),
    children: data.links.filter(
      (l) => l.parentId === runId && l.parentRunId === run.run_id,
    ),
  };
}
