import type { Library } from "./types";

/** Later page data wins for duplicate IDs; source data remains unmodified. */
export function mergeLibrary(current: Library, next: Library): Library {
  const runs = new Map(current.runs.map((run) => [run.id, run]));
  for (const run of next.runs) runs.set(run.id, run);
  return {
    ...next,
    runs: [...runs.values()].sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id),
    ),
    warnings: [...new Set([...current.warnings, ...next.warnings])],
  };
}
