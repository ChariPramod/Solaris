import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import * as storage from "./cloud-storage";
export type ArtifactStorage = Pick<
  typeof storage,
  "readJSON" | "writeJSON" | "readBytes" | "writeBytes" | "listKeys"
>;
import { readRun, validId, parseActions, StoreError } from "./store";
import { summarizeRun } from "./domain";
import type { Library, TrialDetail } from "./types";
export const cloudEnabled = () => process.env.GAUNTLET_STORAGE === "vercel";
const artifactPath =
  /^(?:results\.json|audit\.json|T\d{2}\/[1-9]\d{0,4}\/(?:task\.json|result\.json|lifecycle\.jsonl|actions\.jsonl|\d{3,6}\.jpg|final\.jpg))$/;
const fileSchema = z
  .object({
    key: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(3 * 1024 * 1024),
  })
  .strict();
const indexSchema = z
  .object({
    version: z.literal(1),
    files: z
      .record(z.string().regex(artifactPath), fileSchema)
      .refine((files) => Object.keys(files).length <= 5000),
    updatedAt: z.string(),
  })
  .strict();
export function createCloudArtifacts(deps: ArtifactStorage = storage) {
  const { readJSON, writeJSON, readBytes, writeBytes, listKeys } = deps;
  function parseIndex(id: string, value: unknown) {
    const parsed = indexSchema.safeParse(value);
    if (!parsed.success)
      throw new StoreError(
        "Saved artifact index is invalid. Original objects are retained.",
        503,
      );
    for (const f of Object.values(parsed.data.files))
      if (f.key !== `artifacts/${id}/${f.sha256}`)
        throw new StoreError("Artifact identity mismatch.", 503);
    return parsed.data;
  }
  async function artifactIndex(id: string) {
    validId(id);
    const saved = await readJSON<unknown>(`indexes/${id}.json`);
    if (!saved)
      throw new StoreError(
        "This run has not saved evidence yet. Its job status remains available.",
        404,
      );
    return { ...saved, value: parseIndex(id, saved.value) };
  }
  async function ingestArtifact(id: string, name: string, bytes: Buffer) {
    validId(id);
    if (!Buffer.isBuffer(bytes))
      throw new StoreError("Invalid artifact bytes.");
    if (!artifactPath.test(name))
      throw new StoreError("Invalid artifact path.");
    if (bytes.length > 3 * 1024 * 1024)
      throw new StoreError("Artifact exceeds upload limit.", 413);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const key = `artifacts/${id}/${sha256}`;
    try {
      await writeBytes(
        key,
        bytes,
        name.endsWith(".jpg") ? "image/jpeg" : "application/octet-stream",
      );
    } catch (e) {
      if (!(e instanceof StoreError) || e.status !== 409) throw e;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const saved = await readJSON<unknown>(`indexes/${id}.json`);
      const value = saved
        ? parseIndex(id, saved.value)
        : {
            version: 1 as const,
            files: {},
            updatedAt: new Date().toISOString(),
          };
      if (Object.keys(value.files).length >= 5000 && !value.files[name])
        throw new StoreError("Artifact collection limit reached.", 413);
      value.files[name] = { key, sha256, size: bytes.length };
      value.updatedAt = new Date().toISOString();
      try {
        await writeJSON(`indexes/${id}.json`, value, saved?.etag ?? null);
        return;
      } catch (e) {
        if (!(e instanceof StoreError) || e.status !== 409 || attempt === 3)
          throw e;
      }
    }
  }
  async function bytesFromIndex(
    entry: z.infer<typeof fileSchema>,
    limit: number,
  ) {
    if (entry.size > limit) throw new StoreError("Artifact is too large.", 413);
    const bytes = await readBytes(entry.key, limit);
    if (
      bytes.length !== entry.size ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    )
      throw new StoreError(
        "Artifact checksum failed. Original evidence is retained.",
        503,
      );
    return bytes;
  }
  async function readCloudArtifact(
    id: string,
    name: string,
    limit = 16 * 1024 * 1024,
  ) {
    if (!artifactPath.test(name))
      throw new StoreError("Invalid artifact path.");
    const index = await artifactIndex(id);
    const file = index.value.files[name];
    if (!file) throw new StoreError("Artifact not found.", 404);
    return bytesFromIndex(file, limit);
  }
  async function getCloudEvidenceFiles(id: string) {
    const index = await artifactIndex(id);
    if (!index.value.files["results.json"])
      throw new StoreError("Saved manifest is not available yet.", 404);
    const entries = Object.entries(index.value.files).filter(
      ([name]) =>
        name === "results.json" ||
        /(?:task\.json|result\.json|lifecycle\.jsonl)$/.test(name),
    );
    if (entries.reduce((n, [, f]) => n + f.size, 0) > 128 * 1024 * 1024)
      throw new StoreError("Evidence exceeds the assessment limit.", 413);
    const output: Array<{ path: string; content: Buffer }> = [];
    for (let start = 0; start < entries.length; start += 8) {
      const batch = await Promise.all(
        entries.slice(start, start + 8).map(async ([name, f]) => ({
          path: name,
          content: await bytesFromIndex(f, 16 * 1024 * 1024),
        })),
      );
      output.push(...batch);
    }
    return output;
  }
  async function withEvidenceProject<T>(
    ids: string[],
    fn: (root: string) => Promise<T>,
    allEvidence = false,
  ) {
    for (const id of ids) validId(id);
    if (ids.length > 100) throw new StoreError("Too many runs requested.", 413);
    const root = await mkdtemp(path.join(os.tmpdir(), "gauntlet-cloud-"));
    try {
      for (const id of [...new Set(ids)]) {
        validId(id);
        const files = allEvidence
          ? await getCloudEvidenceFiles(id)
          : [
              {
                path: "results.json",
                content: await readCloudArtifact(id, "results.json"),
              },
            ];
        for (const file of files) {
          const target = path.join(root, "results", id, file.path);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, file.content);
        }
      }
      return await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  async function readCloudRun(id: string) {
    return withEvidenceProject([id], (root) =>
      readRun(id, path.join(root, "results")),
    );
  }
  async function listCloudRuns(): Promise<Library> {
    const index = await listKeys("indexes/", 200);
    const runs: Library["runs"] = [];
    const warnings: string[] = [];
    for (let offset = 0; offset < index.keys.length; offset += 8)
      await Promise.all(
        index.keys.slice(offset, offset + 8).map(async (key) => {
          const id = key.slice("indexes/".length).replace(/\.json$/, "");
          try {
            runs.push(summarizeRun(await readCloudRun(id)));
          } catch {
            warnings.push(
              `${id}: saved manifest is not available yet. Check its job status.`,
            );
          }
        }),
      );
    if (index.truncated) warnings.push("Showing the first 200 saved runs.");
    runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return {
      runs,
      warnings,
      source: "cloud",
      scannedAt: new Date().toISOString(),
    };
  }
  async function readCloudTrial(
    id: string,
    task: string,
    trial: number,
  ): Promise<TrialDetail> {
    if (!/^T\d{2}$/.test(task) || !Number.isSafeInteger(trial) || trial < 1)
      throw new StoreError("Invalid trial identifier.");
    const run = await readCloudRun(id);
    const record = run.records.find(
      (r) => r.task_id === task && r.trial === trial,
    );
    if (!record) throw new StoreError("Trial not found.", 404);
    let frames: TrialDetail["frames"] = [],
      warnings: string[] = [];
    try {
      ({ frames, warnings } = parseActions(
        (
          await readCloudArtifact(
            id,
            `${task}/${trial}/actions.jsonl`,
            4 * 1024 * 1024,
          )
        ).toString(),
      ));
    } catch {
      warnings.push(
        "Action history is missing or unreadable. Saved results remain available.",
      );
    }
    const index = await artifactIndex(id);
    const names = new Set([
      ...frames
        .map((f) => f.screenshot)
        .filter(
          (s): s is string => typeof s === "string" && /^\d{3,6}\.jpg$/.test(s),
        ),
      "final.jpg",
    ]);
    if (names.size > 100) warnings.push("Showing first 100 screenshot names.");
    const screenshots = [...names]
      .slice(0, 100)
      .filter((name) => index.value.files[`${task}/${trial}/${name}`]);
    return { trial: record, frames, warnings, screenshots };
  }

  return {
    artifactIndex,
    ingestArtifact,
    readCloudArtifact,
    getCloudEvidenceFiles,
    withEvidenceProject,
    readCloudRun,
    listCloudRuns,
    readCloudTrial,
  };
}
export type CloudArtifacts = ReturnType<typeof createCloudArtifacts>;
export const {
  artifactIndex,
  ingestArtifact,
  readCloudArtifact,
  getCloudEvidenceFiles,
  withEvidenceProject,
  readCloudRun,
  listCloudRuns,
  readCloudTrial,
} = createCloudArtifacts();
