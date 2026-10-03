import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as storage from "./cloud-storage";
import { readCloudRun } from "./cloud-artifacts";
import { StoreError } from "./store";
import {
  CLIENT_PROJECT_STATUSES,
  type ClientProject,
} from "./client-project-types";

const KEY = "workspace/client-projects.json";
const projectId = z.string().regex(/^project_[a-f0-9]{32}$/);
const text = (limit: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(limit)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const runIds = z
  .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/))
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length);
const deliveryStatus = z.enum(CLIENT_PROJECT_STATUSES);
const notes = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
  );
const inputSchema = z
  .object({
    id: projectId.optional(),
    revision: z.number().int().nonnegative(),
    name: text(80),
    client: text(120),
    // Optional for older callers. Missing update fields preserve the saved value.
    status: deliveryStatus.optional(),
    notes: notes.optional(),
    runIds,
  })
  .strict()
  .refine((value) => (value.id ? value.revision > 0 : value.revision === 0));
const savedSchema = z
  .object({
    id: projectId,
    revision: z.number().int().positive(),
    name: text(80),
    client: text(120),
    // Version-1 project records predate delivery tracking; migrate on read.
    status: deliveryStatus.default("active"),
    notes: notes.default(""),
    runIds,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
const documentSchema = z
  .object({
    version: z.literal(1),
    projects: z.array(savedSchema).max(100),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.projects.map((project) => project.id)).size ===
      value.projects.length,
  );

/** Separate CAS-protected metadata. Run manifests and artifacts are never written here. */
export function createClientProjects(
  deps: Pick<typeof storage, "readJSON" | "writeJSON"> = storage,
  readEvidence: (id: string) => Promise<unknown> = readCloudRun,
) {
  async function readDocument() {
    const saved = await deps.readJSON<unknown>(KEY);
    const parsed = documentSchema.safeParse(
      saved ? saved.value : { version: 1, projects: [] },
    );
    if (!parsed.success)
      throw new StoreError(
        "Client project metadata cannot be read safely. Saved evidence has not been changed.",
        503,
      );
    return { projects: parsed.data.projects, etag: saved?.etag ?? null };
  }
  async function listProjects(): Promise<ClientProject[]> {
    return (await readDocument()).projects.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
  }
  async function saveProject(raw: unknown): Promise<ClientProject> {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success)
      throw new StoreError(
        "Check the project name, client, delivery status, notes (up to 2,000 characters), selected evaluations, and revision.",
        400,
      );
    const input = parsed.data;
    const { projects, etag } = await readDocument();
    const current = projects.find((project) => project.id === input.id);
    if (input.id && !current)
      throw new StoreError(
        "This project is unavailable. Reload the project list.",
        404,
      );
    if (current && current.revision !== input.revision)
      throw new StoreError(
        "This project changed. Reload it before saving; your draft has not been submitted.",
        409,
      );
    if (!current && projects.length >= 100)
      throw new StoreError(
        "This workspace has reached its 100-project limit.",
        409,
      );
    const newReferences = input.runIds.filter(
      (id) => !current?.runIds.includes(id),
    );
    // Only newly assigned references need verification. Existing references survive a
    // temporary evidence outage and can always be removed without rewriting a run.
    for (let offset = 0; offset < newReferences.length; offset += 6) {
      const outcomes = await Promise.allSettled(
        newReferences.slice(offset, offset + 6).map((id) => readEvidence(id)),
      );
      if (outcomes.some((outcome) => outcome.status === "rejected"))
        throw new StoreError(
          "An evaluation could not be verified. Reload the library and try again. No project changes were saved.",
          409,
        );
    }
    const now = new Date().toISOString();
    const project: ClientProject = {
      id: current?.id ?? `project_${randomUUID().replaceAll("-", "")}`,
      revision: (current?.revision ?? 0) + 1,
      name: input.name,
      client: input.client,
      status: input.status ?? current?.status ?? "active",
      notes: input.notes ?? current?.notes ?? "",
      runIds: input.runIds,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await deps.writeJSON(
      KEY,
      {
        version: 1,
        projects: [
          project,
          ...projects.filter((value) => value.id !== project.id),
        ],
      },
      etag,
    );
    return project;
  }
  return { listProjects, saveProject };
}

export const { listProjects, saveProject } = createClientProjects();
