"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  FolderKanban,
  Plus,
  RefreshCw,
  Save,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { ProjectHandoff } from "./project-handoff";
import { api } from "@/lib/client";
import { dateLabel } from "@/lib/domain";
import {
  CLIENT_PROJECT_STATUSES,
  CLIENT_PROJECT_STATUS_LABELS,
  type ClientProject,
  type ClientProjectStatus,
} from "@/lib/client-project-types";
import type { RunCard } from "@/lib/types";

export function ClientProjects({
  runs,
  onOpen,
}: {
  runs: RunCard[];
  onOpen: (id: string) => void;
}) {
  const [projects, setProjects] = useState<ClientProject[]>([]);
  const [current, setCurrent] = useState<ClientProject | null>(null);
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [status, setStatus] = useState<ClientProjectStatus>("active");
  const [notes, setNotes] = useState("");
  const [runIds, setRunIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ClientProjectStatus | "all">(
    "all",
  );
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const editorRef = useRef<HTMLFormElement>(null);
  const byId = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const searchedProjects = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    return projects.filter((project) =>
      `${project.name} ${project.client} ${project.notes}`
        .toLowerCase()
        .includes(query),
    );
  }, [projects, projectSearch]);
  const statusCounts = useMemo(() => {
    const counts: Record<ClientProjectStatus, number> = {
      active: 0,
      review: 0,
      delivered: 0,
      archived: 0,
    };
    for (const project of searchedProjects) counts[project.status]++;
    return counts;
  }, [searchedProjects]);
  const visibleProjects = searchedProjects.filter(
    (project) => statusFilter === "all" || project.status === statusFilter,
  );
  const visibleRuns = useMemo(
    () =>
      runs
        .filter((run) =>
          `${run.id} ${run.model} ${run.task_ids.join(" ")}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
        .slice(0, 200),
    [runs, search],
  );
  const absent = runIds.filter((id) => !byId.has(id));
  const latest = projects.find((project) => project.id === current?.id);

  useEffect(() => {
    const controller = new AbortController();
    api<ClientProject[]>("/api/projects", { signal: controller.signal })
      .then((values) => {
        if (!controller.signal.aborted) {
          setProjects(values);
          setLoaded(true);
        }
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  function edit(project: ClientProject | null) {
    setCurrent(project);
    setName(project?.name ?? "");
    setClient(project?.client ?? "");
    setStatus(project?.status ?? "active");
    setNotes(project?.notes ?? "");
    setRunIds(project?.runIds ?? []);
    setSearch("");
    setError("");
    setMessage("");
    editorRef.current?.focus({ preventScroll: true });
    editorRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setProjects(await api<ClientProject[]>("/api/projects"));
      setLoaded(true);
      setMessage("Project list refreshed. Your editor draft was preserved.");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function save() {
    if (busy || loading || !loaded) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await api<ClientProject>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: current?.id,
          revision: current?.revision ?? 0,
          name,
          client,
          status,
          notes,
          runIds,
        }),
      });
      setProjects((values) => [
        saved,
        ...values.filter((value) => value.id !== saved.id),
      ]);
      setCurrent(saved);
      setName(saved.name);
      setClient(saved.client);
      setStatus(saved.status);
      setNotes(saved.notes);
      setRunIds(saved.runIds);
      setMessage(
        `Saved ${saved.name}, revision ${saved.revision}. Original evaluation evidence is unchanged.`,
      );
    } catch (reason) {
      setError(
        `${(reason as Error).message} Your editor draft is still available.`,
      );
    } finally {
      setBusy(false);
    }
  }
  function toggle(id: string) {
    setRunIds((values) =>
      values.includes(id)
        ? values.filter((value) => value !== id)
        : values.length < 200
          ? [...values, id]
          : values,
    );
  }

  return (
    <section aria-label="Client projects" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <p className="eyebrow">CLIENT DELIVERY</p>
          <h2 className="mt-2 text-xl font-semibold">
            Keep each engagement’s evidence together.
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Group saved evaluations by client and project, track delivery, and
            keep handoff notes beside the original evidence.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || loading}
          onClick={() => void refresh()}
        >
          <RefreshCw aria-hidden="true" />
          Refresh projects
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Projects organize this private owner workspace. They do not create
        separate client accounts or grant client access.
      </p>
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading client projects…
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      {message && (
        <p
          role="status"
          className="rounded-lg border border-primary/25 bg-primary/5 p-3 text-sm"
        >
          {message}
        </p>
      )}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold">
              Projects{" "}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                {loaded ? `${projects.length}/100` : ""}
              </span>
            </h3>
            <Button
              variant="outline"
              size="sm"
              disabled={!loaded || busy || loading}
              onClick={() => edit(null)}
            >
              <Plus aria-hidden="true" />
              New project
            </Button>
          </div>
          {loaded && projects.length > 0 && (
            <div className="space-y-3 rounded-xl border bg-card p-3">
              <label className="block space-y-2 text-sm">
                <span>Search projects</span>
                <Input
                  value={projectSearch}
                  onChange={(event) => setProjectSearch(event.target.value)}
                  placeholder="Project, client, or handoff notes"
                />
              </label>
              <label className="block space-y-2 text-sm">
                <span>Delivery status</span>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(
                      event.target.value as ClientProjectStatus | "all",
                    )
                  }
                >
                  <option value="all">
                    All statuses ({searchedProjects.length})
                  </option>
                  {CLIENT_PROJECT_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {CLIENT_PROJECT_STATUS_LABELS[value]} (
                      {statusCounts[value]})
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-muted-foreground" role="status">
                {visibleProjects.length} of {projects.length} projects shown.
                Counts reflect your search.
              </p>
            </div>
          )}
          {loaded && !projects.length && (
            <div className="rounded-xl border border-dashed p-6">
              <FolderKanban
                aria-hidden="true"
                className="size-6 text-primary"
              />
              <h4 className="mt-3 font-medium">
                Start your first client engagement
              </h4>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Give it a client and project name. You can attach saved
                evaluations now or add them as work progresses.
              </p>
            </div>
          )}
          {loaded && projects.length > 0 && !visibleProjects.length && (
            <p className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
              No projects match this search and delivery status. Your editor
              draft is still available.
            </p>
          )}
          {visibleProjects.map((project) => {
            const savedRuns = project.runIds.flatMap((id) =>
              byId.has(id) ? [byId.get(id)!] : [],
            );
            return (
              <article
                key={project.id}
                className={`min-w-0 rounded-xl border p-4 ${current?.id === project.id ? "border-primary/50 bg-primary/5" : "bg-card"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-xs text-muted-foreground">
                      {project.client}
                    </p>
                    <h4 className="mt-1 break-words font-semibold">
                      {project.name}
                    </h4>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <Badge variant="secondary">
                      {CLIENT_PROJECT_STATUS_LABELS[project.status]}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      Manual · rev {project.revision}
                    </span>
                  </div>
                </div>
                {project.notes && (
                  <p className="mt-3 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {project.notes}
                  </p>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  {project.runIds.length} assigned ·{" "}
                  {savedRuns.filter((run) => run.mode === "live").length} live ·{" "}
                  {savedRuns.filter((run) => run.mode === "dry-run").length}{" "}
                  diagnostic
                  {savedRuns.length < project.runIds.length
                    ? ` · ${project.runIds.length - savedRuns.length} outside loaded library`
                    : ""}
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    Updated {dateLabel(project.updatedAt)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || loading}
                    onClick={() => edit(project)}
                    aria-label={`Edit project ${project.name}`}
                  >
                    Open project <ArrowUpRight aria-hidden="true" />
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
        <form
          ref={editorRef}
          tabIndex={-1}
          aria-label={current ? "Edit client project" : "Create client project"}
          className="min-w-0 scroll-mt-6 rounded-xl border bg-card p-5 focus:outline-none"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">
                {current ? "Edit project" : "New client project"}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {current
                  ? `Editing revision ${current.revision}`
                  : "Saved privately in cloud storage"}
              </p>
            </div>
            {current && latest && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy || loading}
                onClick={() => edit(latest)}
              >
                Reload saved version
              </Button>
            )}
          </div>
          {current && latest && latest.revision !== current.revision && (
            <p role="status" className="mb-4 text-sm text-amber-200">
              A newer revision is available. Reload the saved version before
              editing again.
            </p>
          )}
          <fieldset disabled={busy || loading || !loaded} className="space-y-4">
            <label className="block space-y-2 text-sm">
              <span>Client name</span>
              <Input
                required
                maxLength={120}
                value={client}
                onChange={(event) => setClient(event.target.value)}
                placeholder="Acme Operations"
                autoComplete="off"
              />
            </label>
            <label className="block space-y-2 text-sm">
              <span>Project name</span>
              <Input
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Invoice intake automation"
                autoComplete="off"
              />
            </label>
            <label className="block space-y-2 text-sm">
              <span>Manual delivery status</span>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={status}
                aria-describedby="project-status-help"
                onChange={(event) =>
                  setStatus(event.target.value as ClientProjectStatus)
                }
              >
                {CLIENT_PROJECT_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {CLIENT_PROJECT_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
              <span
                id="project-status-help"
                className="block text-xs leading-relaxed text-muted-foreground"
              >
                Status records your delivery progress. It does not certify an
                automation or change evaluation results. Archived projects
                retain all assignments and can return to any status.
              </span>
            </label>
            <label className="block space-y-2 text-sm">
              <span>Handoff notes</span>
              <textarea
                className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                maxLength={2000}
                rows={4}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Open questions, delivery scope, and next steps for this client."
                aria-describedby="project-notes-help"
              />
              <span
                id="project-notes-help"
                className="block text-xs text-muted-foreground"
              >
                {notes.length}/2,000 characters · Private workspace notes; avoid
                credentials.
              </span>
            </label>
            <div>
              <h4 className="text-sm font-medium">
                Evaluation evidence{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  {runIds.length}/200 assigned
                </span>
              </h4>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Choose from the loaded evaluation library. A run can belong to
                more than one project. Unchecking removes only its project
                assignment.
              </p>
            </div>
            <label className="block space-y-2 text-sm">
              <span className="sr-only">Filter evaluations</span>
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter by model, task, or run ID"
              />
            </label>
            <div
              className="max-h-80 space-y-2 overflow-y-auto rounded-lg border p-2"
              aria-label="Assignable evaluations"
            >
              {!visibleRuns.length && (
                <p className="p-3 text-sm text-muted-foreground">
                  {runs.length
                    ? "No evaluations match this filter."
                    : "No evaluations are loaded yet. Save the project now and attach evidence after your first run."}
                </p>
              )}
              {visibleRuns.map((run) => (
                <div
                  key={run.id}
                  className="flex min-w-0 items-start gap-2 rounded-md px-2 py-2 hover:bg-muted/40"
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 accent-primary"
                      checked={runIds.includes(run.id)}
                      disabled={
                        !runIds.includes(run.id) && runIds.length >= 200
                      }
                      onChange={() => toggle(run.id)}
                    />
                    <span className="min-w-0 text-sm">
                      <span className="block truncate" title={run.model}>
                        {run.model}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {run.mode === "live"
                          ? "Live"
                          : run.mode === "dry-run"
                            ? "Diagnostic"
                            : "Unknown mode"}{" "}
                        · {run.recorded}/{run.planned_trials} recorded ·{" "}
                        {dateLabel(run.created_at)}
                      </span>
                      <span
                        className="mono mt-0.5 block truncate text-[10px] text-muted-foreground"
                        title={run.id}
                      >
                        {run.id}
                      </span>
                    </span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onOpen(run.id)}
                    aria-label={`Inspect assigned evaluation ${run.id}`}
                  >
                    <ArrowUpRight aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
            {absent.length > 0 && (
              <div className="space-y-2 rounded-lg border border-amber-300/20 p-3">
                <p className="text-xs text-muted-foreground">
                  These saved references are outside the loaded library or
                  unavailable. They stay assigned unless removed.
                </p>
                {absent.map((id) => (
                  <label
                    key={id}
                    className="flex min-w-0 items-center gap-2 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked
                      onChange={() => toggle(id)}
                    />
                    <span className="mono min-w-0 break-all">{id}</span>
                  </label>
                ))}
              </div>
            )}
            <Button
              type="submit"
              disabled={
                !name.trim() ||
                !client.trim() ||
                (!current && projects.length >= 100)
              }
            >
              <Save aria-hidden="true" />
              {busy ? "Saving…" : current ? "Save project" : "Create project"}
            </Button>
          </fieldset>
          {current && (
            <ProjectHandoff
              projectId={current.id}
              revision={current.revision}
              disabled={busy || loading || !loaded}
            />
          )}
        </form>
      </div>
    </section>
  );
}
