/** Portable, read-only run snapshots. All validation finishes before the archive is streamed. */
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { z } from "zod";
import * as cloud from "./cloud-artifacts";
import * as storage from "./cloud-storage";
import {
  PROJECT_ROOT,
  parseRun,
  readRun,
  safeFile,
  StoreError,
  validId,
} from "./store";
import { reviewInputSchema } from "./workspace-data";
import type { Run } from "./types";

export const EXPORT_BYTES = 64 * 1024 * 1024;
export const EXPORT_FILES = 5000;
const FILE_BYTES = 16 * 1024 * 1024;
const evidencePath =
  /^(?:results\.json|audit\.json|T\d{2}\/[1-9]\d{0,4}\/(?:task\.json|baseline\.json|result\.json|lifecycle\.jsonl|actions\.jsonl|\d{3,6}\.jpg|final\.jpg))$/;
const metadataName = /^(?:presets|attempts|review-[a-f0-9]{64})\.json$/;
const terminal = new Set(["complete", "failed", "interrupted", "cancelled"]);
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const encoded = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");
const changed = () =>
  new StoreError(
    "Run evidence or reviews changed during export. Wait for the run to stop, then retry.",
    409,
  );
const corrupt = () =>
  new StoreError(
    "Evidence export cannot read consistent saved metadata. Original data is unchanged.",
    503,
  );

export type ExportEntry = {
  path: string;
  size: number;
  sha256?: string;
  key?: string;
  revision?: string;
};
export type ExportSnapshot = {
  revision: string;
  run: Run;
  entries: ExportEntry[];
  annotations: Record<string, Buffer>;
  provenance: Record<string, unknown> | null;
};
export type EvidenceExportSource = {
  kind: "cloud" | "local";
  snapshot(id: string): Promise<ExportSnapshot>;
  read(id: string, entry: ExportEntry): Promise<Buffer>;
};

const reviewSchema = z
  .object({
    version: z.literal(1),
    runId: z.string(),
    taskId: z.string().regex(/^T\d{2}$/),
    trial: z.number().int().positive().max(99999),
    history: z
      .array(
        reviewInputSchema
          .extend({
            revision: z.number().int().min(1).max(100),
            updatedAt: z.string().datetime(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
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

/** Whitelist run-specific documents; presets, unrelated reviews and job tokens never enter the archive. */
export function scopeExportAnnotations(
  id: string,
  files: Record<string, string>,
) {
  validId(id);
  const selected: Record<string, Buffer> = {};
  try {
    for (const name of Object.keys(files).sort()) {
      if (!/^review-[a-f0-9]{64}\.json$/.test(name)) continue;
      const raw = JSON.parse(files[name]);
      if (!raw || typeof raw.runId !== "string") throw corrupt();
      if (raw.runId !== id) continue;
      const review = reviewSchema.parse(raw);
      const expected = `review-${hash(JSON.stringify([id, review.taskId, review.trial]))}.json`;
      if (
        expected !== name ||
        review.history.some((item, i) => item.revision !== i + 1)
      )
        throw corrupt();
      selected[`workspace/${name}`] = encoded(review);
    }
    const attempts = files["attempts.json"]
      ? z
          .object({
            version: z.literal(1),
            links: z.array(linkSchema).max(1000),
          })
          .strict()
          .parse(JSON.parse(files["attempts.json"]))
      : { version: 1 as const, links: [] };
    const children = new Set<string>();
    for (const link of attempts.links) {
      validId(link.parentId);
      validId(link.childId);
      if (
        children.has(link.childId) ||
        link.childId === link.parentId ||
        link.childRunId === link.parentRunId
      )
        throw corrupt();
      children.add(link.childId);
    }
    selected["workspace/attempts.json"] = encoded({
      version: 1,
      links: attempts.links.filter(
        (link) => link.parentId === id || link.childId === id,
      ),
    });
    return selected;
  } catch {
    throw corrupt();
  }
}

function annotationDigest(annotations: Record<string, Buffer>) {
  return Object.keys(annotations)
    .sort()
    .map((name) => [name, hash(annotations[name])]);
}

const metadataSchema = z
  .object({
    version: z.literal(1),
    files: z.record(z.string().regex(metadataName), z.string()),
  })
  .strict()
  .refine(
    (value) =>
      Object.keys(value.files).length <= 10002 &&
      Object.values(value.files).reduce(
        (sum, file) => sum + Buffer.byteLength(file),
        0,
      ) <=
        12 * 1024 * 1024,
  );

/** Only this narrow projection is exported. Deliberately omit callback tokens, SDK identities and errors. */
function jobProvenance(id: string, value: unknown) {
  if (value === null) return null;
  const parsed = z
    .object({
      id: z.literal(id),
      status: z.enum([
        "starting",
        "running",
        "cancelling",
        "complete",
        "failed",
        "interrupted",
        "cancelled",
      ]),
      mode: z.enum(["dry-run", "live"]),
      sourceRevision: z.string().regex(/^[a-fA-F0-9]{40}$/),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      exitCode: z.number().int().nullable().optional(),
    })
    .safeParse(value);
  if (!parsed.success) throw corrupt();
  if (!terminal.has(parsed.data.status))
    throw new StoreError(
      "This evaluation is still active. Stop it or wait for completion before exporting evidence.",
      409,
    );
  return parsed.data;
}

export function cloudExportSource(
  artifacts: Pick<cloud.CloudArtifacts, "artifactIndex"> = cloud,
  objects: Pick<typeof storage, "readBytes" | "readJSON"> = storage,
): EvidenceExportSource {
  return {
    kind: "cloud",
    async snapshot(id) {
      validId(id);
      const [index, metadata, job] = await Promise.all([
        artifacts.artifactIndex(id),
        objects.readJSON<unknown>("workspace/metadata.json"),
        objects.readJSON<unknown>(`jobs/${id}.json`),
      ]);
      const manifest = index.value.files["results.json"];
      if (!manifest)
        throw new StoreError("Saved run manifest is missing.", 404);
      const bytes = await objects.readBytes(manifest.key, FILE_BYTES);
      if (bytes.length !== manifest.size || hash(bytes) !== manifest.sha256)
        throw new StoreError("Manifest checksum failed during export.", 503);
      let run: Run;
      try {
        run = parseRun(id, JSON.parse(bytes.toString("utf8")));
      } catch {
        throw new StoreError(
          "Saved run manifest is invalid. Original evidence is unchanged.",
          503,
        );
      }
      const parsed = metadataSchema.safeParse(
        metadata ? metadata.value : { version: 1, files: {} },
      );
      if (!parsed.success) throw corrupt();
      const annotations = scopeExportAnnotations(id, parsed.data.files);
      const provenance = jobProvenance(id, job?.value ?? null);
      if (!provenance && run.status === "running") throw changed();
      const entries = Object.entries(index.value.files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, file]) => ({ path: name, ...file }));
      return {
        run,
        entries,
        annotations,
        provenance,
        revision: hash(
          JSON.stringify({
            index: index.etag,
            files: entries,
            annotations: annotationDigest(annotations),
            provenance,
          }),
        ),
      };
    },
    async read(_id, entry) {
      if (!entry.key) throw corrupt();
      return objects.readBytes(entry.key, FILE_BYTES);
    },
  };
}

async function directory(location: string) {
  const stat = await lstat(location);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new StoreError(
      "Evidence folders must be real directories, not links.",
      503,
    );
  return readdir(location, { withFileTypes: true });
}
async function localEntries(root: string, id: string) {
  const entries: ExportEntry[] = [];
  await directory(root);
  const base = path.join(root, id);
  let visited = 0;
  async function walk(relative = "") {
    for (const item of await directory(path.join(base, relative))) {
      if (++visited > 20000)
        throw new StoreError(
          "Evidence directory exceeds the export scan limit.",
          413,
        );
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (evidencePath.test(name)) {
        const stat = await lstat(path.join(base, name), { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new StoreError(
            "Linked or non-file evidence cannot be exported.",
            503,
          );
        entries.push({
          path: name,
          size: Number(stat.size),
          revision: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
        });
        if (entries.length > EXPORT_FILES)
          throw new StoreError(
            "Evidence exceeds the 5,000-file export limit.",
            413,
          );
      } else if (/^T\d{2}(?:\/[1-9]\d{0,4})?$/.test(name)) {
        await walk(name);
      }
    }
  }
  await walk();
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
async function localAnnotations(projectRoot: string, id: string) {
  const location = path.join(projectRoot, ".gauntlet-workspace");
  let names;
  try {
    names = await directory(location);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return scopeExportAnnotations(id, {});
    throw error;
  }
  if (names.length > 10010)
    throw new StoreError(
      "Workspace metadata exceeds the export scan limit.",
      413,
    );
  const files: Record<string, string> = {};
  let bytes = 0;
  for (const entry of names) {
    if (!metadataName.test(entry.name) || entry.name === "presets.json")
      continue;
    const content = await safeFile(location, [entry.name], FILE_BYTES);
    bytes += content.length;
    if (bytes > 12 * 1024 * 1024)
      throw new StoreError("Workspace metadata exceeds the export limit.", 413);
    files[entry.name] = content.toString("utf8");
  }
  return scopeExportAnnotations(id, files);
}
export function localExportSource(
  projectRoot = PROJECT_ROOT,
): EvidenceExportSource {
  const root = path.join(projectRoot, "results");
  return {
    kind: "local",
    async snapshot(id) {
      validId(id);
      const entries = await localEntries(root, id);
      const [run, annotations] = await Promise.all([
        readRun(id, root),
        localAnnotations(projectRoot, id),
      ]);
      if (run.status === "running")
        throw new StoreError(
          "This run is still marked running. Stop it or recover its saved evidence before exporting.",
          409,
        );
      return {
        entries,
        run,
        annotations,
        provenance: null,
        revision: hash(
          JSON.stringify({
            entries,
            annotations: annotationDigest(annotations),
          }),
        ),
      };
    },
    read(id, entry) {
      return safeFile(root, [id, ...entry.path.split("/")], FILE_BYTES);
    },
  };
}

type ArchiveFile = { path: string; bytes: Buffer };
/** Minimal POSIX ustar writer: regular files only, fixed safe names, no links or executable modes. */
function tarHeader(name: string, size: number) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(name) ||
    name.includes("..") ||
    Buffer.byteLength(name) > 99
  )
    throw new StoreError("Unsafe export path.", 503);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  for (const [offset, width, value] of [
    [100, 8, 0o600],
    [108, 8, 0],
    [116, 8, 0],
    [124, 12, size],
    [136, 12, 0],
  ])
    header.write(
      value.toString(8).padStart(width - 1, "0") + "\0",
      offset,
      width,
      "ascii",
    );
  header.fill(0x20, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(
    header
      .reduce((sum, value) => sum + value, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
    148,
    8,
    "ascii",
  );
  return header;
}
function* tar(files: ArchiveFile[]) {
  for (const file of files) {
    yield tarHeader(file.path, file.bytes.length);
    for (let offset = 0; offset < file.bytes.length; offset += 64 * 1024)
      yield file.bytes.subarray(offset, offset + 64 * 1024);
    if (file.bytes.length % 512)
      yield Buffer.alloc(512 - (file.bytes.length % 512));
  }
  yield Buffer.alloc(1024);
}
function handoff(run: Run, files: ArchiveFile[], exportedAt: string) {
  const passed = run.records.filter((record) => record.passed).length;
  const infrastructure = run.records.filter(
    (record) => record.failure_class === "infra_error",
  ).length;
  const cleanup = run.records.filter((record) => record.cleanup_error).length;
  const unknownCosts = run.records.filter(
    (record) => record.cost_usd === null || record.cost_status === "unknown",
  ).length;
  const reviews = files.filter((file) =>
    file.path.startsWith("workspace/review-"),
  ).length;
  const tasks = run.task_ids
    .map((id) => {
      const trials = run.records.filter((record) => record.task_id === id);
      return `| ${id} | ${trials.length}/${run.trials_per_task} | ${trials.filter((trial) => trial.passed).length} | ${trials.filter((trial) => trial.failure_class === "infra_error").length} | ${trials.filter((trial) => trial.cleanup_error).length} |`;
    })
    .join("\n");
  return Buffer.from(
    `# Solaris evaluation handoff\n\n` +
      `Run directory: ${run.id}\n\nExported: ${exportedAt}\n\n` +
      `- Mode: ${run.mode === "live" ? "live" : "diagnostic / non-live"}.\n` +
      `- Saved run status: ${JSON.stringify(run.status)}.\n` +
      `- Recorded trials: ${run.records.length} of ${run.planned_trials} planned.\n` +
      `- Passed recorded trials: ${passed} of ${run.records.length}.\n` +
      `- Infrastructure failures: ${infrastructure}. Cleanup errors: ${cleanup}.\n` +
      `- Trials with unknown cost: ${unknownCosts}.\n` +
      `- Saved human review histories: ${reviews}.\n\n` +
      "| Task | Recorded/planned | Passed | Infrastructure failures | Cleanup errors |\n| --- | --- | --- | --- | --- |\n" +
      tasks +
      "\n\n" +
      (run.mode === "live"
        ? "Live results apply to this saved task plan and configuration only.\n\n"
        : "This diagnostic run validates the evaluation workflow. It does not measure AI model performance.\n\n") +
      "This export is a snapshot of saved evidence, not a release approval, proof of remote resource deletion, or a whole-workspace backup. Missing planned trials remain missing. Review verdicts do not replace original verifier results.\n\n" +
      "All indexed artifacts are included under evidence/. Review histories and direct attempt links are under workspace/. inventory.json lists all payload files with byte counts and SHA-256 checksums; checksums.sha256 also covers the inventory and supports shasum -a 256 -c checksums.sha256 after extraction. Related runs themselves are not included.\n\n" +
      "Evidence may include screenshots, prompts and human notes. Inspect it before sharing with a client. Restore/import is not implemented by this download.\n",
  );
}

export async function createEvidenceBundle(
  id: string,
  source: EvidenceExportSource,
  now = new Date(),
  signal?: AbortSignal,
) {
  validId(id);
  signal?.throwIfAborted();
  const before = await source.snapshot(id);
  if (!before.entries.some((entry) => entry.path === "results.json"))
    throw new StoreError("Saved run manifest is missing.", 404);
  if (before.entries.length > EXPORT_FILES)
    throw new StoreError("Evidence exceeds the 5,000-file export limit.", 413);
  const names = new Set<string>();
  let total = Object.values(before.annotations).reduce(
    (sum, bytes) => sum + bytes.length,
    0,
  );
  for (const entry of before.entries) {
    if (
      !evidencePath.test(entry.path) ||
      names.has(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      (entry.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(entry.sha256))
    )
      throw corrupt();
    names.add(entry.path);
    total += entry.size;
    if (entry.size > FILE_BYTES || total > EXPORT_BYTES)
      throw new StoreError(
        "Evidence exceeds the 64 MiB export limit or the 16 MiB per-file limit. No files were omitted. Archive this run through your storage administrator.",
        413,
      );
  }
  const files: ArchiveFile[] = [];
  for (let start = 0; start < before.entries.length; start += 8) {
    signal?.throwIfAborted();
    files.push(
      ...(await Promise.all(
        before.entries.slice(start, start + 8).map(async (entry) => {
          const bytes = await source.read(id, entry);
          if (
            !Buffer.isBuffer(bytes) ||
            bytes.length !== entry.size ||
            (entry.sha256 && hash(bytes) !== entry.sha256)
          )
            throw new StoreError(
              "Artifact checksum or size failed during export. No archive was created; original evidence is unchanged.",
              503,
            );
          return { path: `evidence/${entry.path}`, bytes };
        }),
      )),
    );
  }
  for (const [name, bytes] of Object.entries(before.annotations))
    files.push({ path: name, bytes });
  if (before.provenance)
    files.push({ path: "provenance.json", bytes: encoded(before.provenance) });
  const exportedAt = now.toISOString();
  files.push({
    path: "HANDOFF.md",
    bytes: handoff(before.run, files, exportedAt),
  });
  const inventory = {
    format: "solaris-evidence",
    version: 1,
    runId: id,
    source: source.kind,
    exportedAt,
    snapshot: before.revision,
    status: before.run.status,
    plannedTrials: before.run.planned_trials,
    recordedTrials: before.run.records.length,
    scope: "all-saved-run-artifacts-and-run-annotations",
    files: files.map((file) => ({
      path: file.path,
      size: file.bytes.length,
      sha256: hash(file.bytes),
    })),
  };
  files.push({ path: "inventory.json", bytes: encoded(inventory) });
  files.push({
    path: "checksums.sha256",
    bytes: Buffer.from(
      files.map((file) => `${hash(file.bytes)}  ${file.path}\n`).join(""),
    ),
  });
  // Metadata edits, index replacements, new evidence and local file replacements invalidate the whole snapshot.
  if ((await source.snapshot(id)).revision !== before.revision) throw changed();
  signal?.throwIfAborted();
  // Force safe header validation before returning HTTP 200; only compression/transport can fail afterwards.
  files.forEach((file) => tarHeader(file.path, file.bytes.length));
  const raw = Readable.from(tar(files));
  const stream = raw.pipe(createGzip({ level: 6 }));
  stream.once("close", () => raw.destroy());
  return {
    filename: `${id}-evidence.tar.gz`,
    snapshot: before.revision,
    fileCount: files.length,
    // A real chunked stream avoids the buffered Vercel response size limit. No Content-Length is set.
    stream: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
  };
}
