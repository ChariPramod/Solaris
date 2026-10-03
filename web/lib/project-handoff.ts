import { listProjects } from "./client-projects";
import {
  CLIENT_PROJECT_STATUS_LABELS,
  type ClientProject,
} from "./client-project-types";
import { readCloudRunSnapshot } from "./cloud-artifacts";
import { StoreError, validId } from "./store";
import type { Run } from "./types";

export type HandoffFormat = "markdown" | "json";
type ManifestSnapshot = { run: Run; manifestSha256: string };
type Dependencies = {
  listProjects(): Promise<ClientProject[]>;
  readRun(id: string): Promise<ManifestSnapshot>;
  now(): Date;
};
const projectId = /^project_[a-f0-9]{32}$/;
const knownStatuses = new Set([
  "running",
  "complete",
  "stopped",
  "interrupted",
  "failed",
  "cancelled",
]);

export function parseHandoffQuery(query: URLSearchParams): {
  revision: number;
  format: HandoffFormat;
} {
  for (const key of query.keys())
    if (!["revision", "format"].includes(key) || query.getAll(key).length !== 1)
      throw new StoreError(
        "Use one revision and an optional markdown or json format.",
      );
  const value = query.get("revision") ?? "";
  const revision = Number(value);
  const format = query.get("format") ?? "markdown";
  if (
    !/^[1-9]\d{0,15}$/.test(value) ||
    !Number.isSafeInteger(revision) ||
    !["markdown", "json"].includes(format)
  )
    throw new StoreError(
      "Choose a saved project revision and markdown or json format.",
    );
  return { revision, format: format as HandoffFormat };
}

function describeRun(
  id: string,
  snapshot: ManifestSnapshot,
  capturedAt: string,
) {
  const { run, manifestSha256 } = snapshot;
  if (
    run.id !== id ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    run.model.length > 500
  )
    throw new StoreError("The manifest summary is unavailable.", 503);
  const mode =
    run.mode === "live" && run.records.every((record) => record.mode === "live")
      ? "live"
      : run.mode === "dry-run" &&
          run.records.every((record) => record.mode === "dry-run")
        ? "diagnostic"
        : "unknown";
  const missing = run.planned_trials - run.records.length;
  const unknownCostTrials = run.records.filter(
    (record) => record.cost_usd === null || record.cost_status === "unknown",
  ).length;
  const total = run.records.reduce(
    (sum, record) => sum + (record.cost_usd ?? 0),
    0,
  );
  const cost =
    missing === 0 && unknownCostTrials === 0 && Number.isFinite(total)
      ? total
      : null;
  return {
    id,
    availability: "available" as const,
    capturedAt,
    manifestSha256,
    mode,
    model: run.model,
    status: knownStatuses.has(run.status) ? run.status : "unknown",
    createdAt: Number.isNaN(Date.parse(run.created_at))
      ? null
      : new Date(run.created_at).toISOString(),
    taskIds: [...run.task_ids],
    plannedTrials: run.planned_trials,
    recordedTrials: run.records.length,
    missingTrials: missing,
    passedTrials: run.records.filter((record) => record.passed).length,
    infrastructureFailures: run.records.filter(
      (record) => record.failure_class === "infra_error",
    ).length,
    cleanupErrors: run.records.filter((record) => Boolean(record.cleanup_error))
      .length,
    unknownCostTrials,
    estimatedModelCostUsd: cost,
    evidenceBundlePath: `/api/runs/${id}/bundle`,
  };
}

export function createProjectHandoff(
  deps: Dependencies = {
    listProjects,
    readRun: readCloudRunSnapshot,
    now: () => new Date(),
  },
) {
  return async function collect(
    id: string,
    revision: number,
    signal?: AbortSignal,
  ) {
    if (!projectId.test(id) || !Number.isSafeInteger(revision) || revision < 1)
      throw new StoreError("Choose a saved project and revision.");
    signal?.throwIfAborted();
    const project = (await deps.listProjects()).find(
      (value) => value.id === id,
    );
    if (!project)
      throw new StoreError(
        "This project is unavailable. Refresh the project list.",
        404,
      );
    if (project.revision !== revision)
      throw new StoreError(
        "This project changed. Reload the saved version before exporting.",
        409,
      );
    // Capture only whitelisted metadata. Notes and any future private fields never enter the export.
    const selected = {
      id: project.id,
      revision: project.revision,
      name: project.name,
      client: project.client,
      deliveryStatus: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    const runIds = [...project.runIds];
    if (runIds.length > 200 || new Set(runIds).size !== runIds.length)
      throw new StoreError("Project references cannot be read safely.", 503);
    runIds.forEach(validId);
    const startedAt = deps.now().toISOString();
    type Available = ReturnType<typeof describeRun>;
    type Unavailable = {
      id: string;
      availability: "unavailable";
      reason: "missing" | "changed" | "unavailable";
    };
    const runs: Array<Available | Unavailable> = [];
    for (let offset = 0; offset < runIds.length; offset += 6) {
      signal?.throwIfAborted();
      runs.push(
        ...(await Promise.all(
          runIds
            .slice(offset, offset + 6)
            .map(async (runId): Promise<Available | Unavailable> => {
              try {
                const snapshot = await deps.readRun(runId);
                signal?.throwIfAborted();
                return describeRun(runId, snapshot, deps.now().toISOString());
              } catch (error) {
                signal?.throwIfAborted();
                // Provider exceptions can contain URLs or tokens. Export only this fixed reason vocabulary.
                return {
                  id: runId,
                  availability: "unavailable",
                  reason:
                    error instanceof StoreError && error.status === 404
                      ? "missing"
                      : error instanceof StoreError && error.status === 409
                        ? "changed"
                        : "unavailable",
                };
              }
            }),
        )),
      );
    }
    signal?.throwIfAborted();
    const latest = (await deps.listProjects()).find((value) => value.id === id);
    if (!latest || latest.revision !== revision)
      throw new StoreError(
        "This project changed during export. Reload the saved version and retry.",
        409,
      );
    const unavailableRuns = runs.filter(
      (run) => run.availability === "unavailable",
    ).length;
    return {
      format: "solaris-project-handoff" as const,
      version: 1 as const,
      scope: "project-metadata-and-verified-manifest-summaries" as const,
      startedAt,
      exportedAt: deps.now().toISOString(),
      project: selected,
      privateNotesIncluded: false as const,
      assignedRuns: runIds.length,
      availableRuns: runIds.length - unavailableRuns,
      unavailableRuns,
      runs,
      limitations: [
        "Each manifest is captured and checksum-verified independently. This is not an atomic snapshot of all project evidence.",
        "Delivery status is assigned manually and does not certify a quality gate or release approval.",
        "Diagnostic runs validate the evaluation workflow, not AI model performance. Unknown modes are not live validation.",
        "Missing evaluations and planned trials remain missing. No success rate is aggregated across evaluations.",
        "Cost is a saved model estimate, excludes desktop/provider reconciliation, and is unknown when trial coverage or recorded costs are incomplete.",
        "Evidence bundle paths require owner sign-in to the original workspace. Downloads reflect evidence at download time and can differ from this manifest digest.",
        "Private project notes, prompts, screenshots, review text and credentials are excluded. This is not an evidence bundle or a workspace backup.",
      ],
    };
  };
}

export type ProjectHandoff = Awaited<
  ReturnType<ReturnType<typeof createProjectHandoff>>
>;
export const collectProjectHandoff = createProjectHandoff();

/** User text remains literal, including HTML, Markdown links, table delimiters and line breaks. */
function literal(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\\`*_\[\]{}()#+.!|:~=-]/g, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderProjectHandoff(value: ProjectHandoff) {
  const project = value.project;
  const lines = [
    "# Solaris project handoff",
    "",
    `Project: ${literal(project.name)}`,
    "",
    `Client: ${literal(project.client)}`,
    "",
    `Saved project: ${project.id} · revision ${project.revision}`,
    "",
    `Manual delivery status: ${CLIENT_PROJECT_STATUS_LABELS[project.deliveryStatus]}`,
    "",
    `Collection started: ${value.startedAt}`,
    "",
    `Exported: ${value.exportedAt}`,
    "",
    `${value.assignedRuns} evaluations assigned · ${value.availableRuns} manifests verified · ${value.unavailableRuns} unavailable`,
    "",
    "Private project notes are excluded. Unsaved editor changes are excluded.",
    "",
    "## Assigned evaluations",
    "",
  ];
  if (!value.runs.length)
    lines.push("No evaluations are assigned to this saved project.", "");
  for (const run of value.runs) {
    lines.push(`### ${literal(run.id)}`, "");
    if (run.availability === "unavailable") {
      const reason =
        run.reason === "changed"
          ? "The manifest changed during collection. Retry when the evaluation is stable."
          : run.reason === "missing"
            ? "The manifest is missing or cannot be read."
            : "Evidence is unavailable or could not be verified. Retry or inspect the evaluation.";
      lines.push(
        `Unavailable: ${reason}`,
        "",
        "No outcome or cost was inferred for this evaluation.",
        "",
      );
      continue;
    }
    lines.push(
      `- Mode: ${run.mode === "diagnostic" ? "diagnostic / non-live; not AI model performance" : run.mode === "live" ? "live" : "unknown; not verified as live"}.`,
      `- Model: ${literal(run.model)}.`,
      `- Saved run status: ${literal(run.status)}.`,
      `- Tasks: ${run.taskIds.join(", ") || "none"}.`,
      `- Recorded trials: ${run.recordedTrials}/${run.plannedTrials}; missing planned trials: ${run.missingTrials}.`,
      `- Passed recorded trials: ${run.passedTrials}/${run.recordedTrials}.`,
      `- Infrastructure failures: ${run.infrastructureFailures}; cleanup errors: ${run.cleanupErrors}.`,
      `- Estimated model cost (USD): ${run.estimatedModelCostUsd === null ? "unknown" : String(run.estimatedModelCostUsd)}; recorded trials with unknown cost: ${run.unknownCostTrials}.`,
      `- Captured: ${run.capturedAt}.`,
      `- Manifest SHA-256: ${run.manifestSha256}.`,
      `- Evidence bundle path (owner sign-in required): \`${run.evidenceBundlePath}\`.`,
      "",
    );
  }
  lines.push(
    "## Scope and limitations",
    "",
    ...value.limitations.map((line) => `- ${line}`),
    "",
  );
  return lines.join("\n");
}
