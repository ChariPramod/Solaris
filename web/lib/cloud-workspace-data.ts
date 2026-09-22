/** Reuse the tested workspace rules, with Blob compare-and-swap instead of local filesystem ownership. */
import { mkdir, readdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import * as local from "./workspace-data";
import * as storage from "./cloud-storage";
import * as artifacts from "./cloud-artifacts";
import { StoreError, validId } from "./store";
const documentSchema = z
  .object({
    version: z.literal(1),
    files: z.record(
      z.string().regex(/^(?:presets|attempts|review-[a-f0-9]{64})\.json$/),
      z.string(),
    ),
  })
  .strict()
  .refine(
    (doc) =>
      Object.keys(doc.files).length <= 10002 &&
      Object.values(doc.files).reduce((n, s) => n + Buffer.byteLength(s), 0) <=
        12 * 1024 * 1024,
  );
export function createCloudWorkspaceData(
  deps: Pick<typeof storage, "readJSON" | "writeJSON"> = storage,
  evidence: Pick<typeof artifacts, "withEvidenceProject"> = artifacts,
) {
  const { readJSON, writeJSON } = deps;
  const { withEvidenceProject } = evidence;
  async function transaction<T>(
    ids: string[],
    write: boolean,
    operation: (options: local.WorkspaceOptions) => Promise<T>,
  ) {
    for (const id of ids) validId(id);
    const saved = await readJSON<unknown>("workspace/metadata.json");
    const parsed = documentSchema.safeParse(
      saved ? saved.value : { version: 1, files: {} },
    );
    if (!parsed.success)
      throw new StoreError(
        "Workspace metadata is corrupt. Original data has not been changed.",
        503,
      );
    const document = parsed.data;
    return withEvidenceProject(
      ids,
      async (root) => {
        const directory = path.join(root, ".gauntlet-workspace");
        await mkdir(directory);
        for (const [name, content] of Object.entries(document.files))
          await writeFile(path.join(directory, name), content, { mode: 0o600 });
        const result = await operation({ projectRoot: root });
        if (write) {
          const files: Record<string, string> = {};
          let size = 0;
          for (const name of await readdir(directory)) {
            if (!name.endsWith(".json")) continue;
            const contents = await readFile(path.join(directory, name), "utf8");
            size += Buffer.byteLength(contents);
            if (size > 12 * 1024 * 1024)
              throw new StoreError(
                "Workspace metadata is full. Existing notes are preserved.",
                413,
              );
            files[name] = contents;
          }
          if (!documentSchema.safeParse({ version: 1, files }).success)
            throw new StoreError(
              "Workspace metadata cannot be saved safely.",
              503,
            );
          await writeJSON(
            "workspace/metadata.json",
            { version: 1, files },
            saved?.etag ?? null,
          );
        }
        return result;
      },
      true,
    );
  }
  const getReview = (id: string, task: string, trial: number) =>
    transaction([id], false, (o) => local.getReview(id, task, trial, o));
  const saveReview = (
    id: string,
    task: string,
    trial: number,
    input: unknown,
  ) =>
    transaction([id], true, (o) => local.saveReview(id, task, trial, input, o));
  const listPresets = () => transaction([], false, (o) => local.listPresets(o));
  const savePreset = (input: unknown) =>
    transaction([], true, (o) => local.savePreset(input, o));
  const getAttempts = (id: string) =>
    transaction([id], false, (o) => local.getAttempts(id, o));
  const recordAttempt = (parent: string, child: string) =>
    transaction([parent, child], true, (o) =>
      local.recordAttempt(parent, child, o),
    );

  return {
    getReview,
    saveReview,
    listPresets,
    savePreset,
    getAttempts,
    recordAttempt,
  };
}
export const {
  getReview,
  saveReview,
  listPresets,
  savePreset,
  getAttempts,
  recordAttempt,
} = createCloudWorkspaceData();
