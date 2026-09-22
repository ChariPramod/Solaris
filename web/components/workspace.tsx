"use client";
import { WorkspaceIntro } from "./workspace-intro";
import { CloudLiveLaunch } from "./cloud-live-launch";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Beaker,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  Database,
  FileSearch,
  FlaskConical,
  FolderOpen,
  Layers3,
  Loader2,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShineBorder } from "@/components/ui/shine-border";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  Audit,
  Library,
  Readiness,
  Run,
  RunSetup,
  RunCard,
  Trial,
} from "@/lib/types";
import {
  dateLabel,
  liveCommand,
  passRate,
  percent,
  prettyName,
  summarizeRun,
  TASK_IDS,
  TASK_NAMES,
  verdict,
} from "@/lib/domain";
import { registerWorkspaceTools } from "@/lib/webmcp";
import { api } from "@/lib/client";
import { TrialEvidence } from "@/components/trial-evidence";
import { RunAssessment } from "@/components/run-assessment";
import { SavedSetups } from "@/components/saved-setups";
import { AttemptHistory } from "@/components/attempt-history";
import { CloudJobs } from "@/components/cloud-jobs";
import type { PublicCloudJob } from "@/lib/cloud-runner";
import { cn } from "@/lib/utils";

function Status({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "status",
        status === "complete"
          ? "status-ok"
          : status === "stopped" || status === "interrupted"
            ? "status-warn"
            : "status-neutral",
      )}
    >
      <span className="status-dot" />
      {prettyName(status)}
    </Badge>
  );
}
function Notice({
  children,
  tone = "info",
}: {
  children: React.ReactNode;
  tone?: "info" | "warning" | "error";
}) {
  return (
    <div
      className={cn("notice", `notice-${tone}`)}
      role={tone === "error" ? "alert" : undefined}
    >
      <CircleAlert size={17} />
      <div>{children}</div>
    </div>
  );
}
function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <FolderOpen size={30} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Metric({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: typeof Activity;
}) {
  return (
    <div className="metric">
      <div className="metric-top">
        <span>{label}</span>
        <Icon size={16} />
      </div>
      <strong>{value}</strong>
      <span className="metric-detail">{detail}</span>
    </div>
  );
}

export function Workspace({ cloud = false }: { cloud?: boolean }) {
  const [library, setLibrary] = useState<Library | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<"runs" | "tasks" | "readiness">("runs");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [dialogVersion, setDialogVersion] = useState(0);
  const [rerunSource, setRerunSource] = useState<Run | null>(null);
  const [taskPreset, setTaskPreset] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [toast, setToast] = useState("");
  const [jobsRevision, setJobsRevision] = useState(0);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await api<Library>("/api/runs");
      if (mounted.current) {
        setLibrary(data);
        setError("");
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(
    () =>
      registerWorkspaceTools({
        list: () => api<Library>("/api/runs"),
        open: (id) => {
          setView("runs");
          setSelected(id);
        },
      }),
    [],
  );
  const runs = library?.runs || [];
  const filtered = useMemo(
    () =>
      runs.filter(
        (r) =>
          (filter === "all" ||
            (filter === "attention"
              ? r.status === "stopped" ||
                r.status === "interrupted" ||
                r.cleanup > 0
              : r.mode === filter)) &&
          `${r.id} ${r.model} ${r.status}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [runs, filter, search],
  );
  const total = runs.reduce((n, r) => n + r.recorded, 0);
  const live = runs.filter((r) => r.mode === "live");
  const attention = runs.filter(
    (r) =>
      r.status === "stopped" || r.status === "interrupted" || r.cleanup > 0,
  ).length;
  return (
    <MotionConfig reducedMotion="user">
      <a href="#main" className="skip-link">
        Skip to workspace
      </a>
      <div className="workspace-shell">
        <aside className="sidebar">
          <a className="brand" href="/" aria-label="Solaris home">
            <span className="brand-mark">
              <Layers3 size={22} />
            </span>
            <span>
              solaris<span className="brand-sub">WORKSPACE</span>
            </span>
          </a>
          <div className="workspace-switch">
            <div className="workspace-avatar">S</div>
            <div>
              <strong>Solaris</strong>
              <span>{cloud ? "Cloud workspace" : "Local workspace"}</span>
            </div>
            <span className="local-dot" />
          </div>
          <p className="nav-label">WORKSPACE</p>
          <nav aria-label="Workspace">
            {(
              [
                { id: "runs", label: "Evaluations", icon: Layers3 },
                { id: "tasks", label: "Task suite", icon: Beaker },
                { id: "readiness", label: "Readiness", icon: ShieldCheck },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                aria-label={item.label}
                className={cn("nav-item", view === item.id && "active")}
                onClick={() => {
                  setView(item.id);
                  setSelected(null);
                }}
              >
                <item.icon size={18} />
                {item.label}
                {item.id === "runs" && (
                  <span className="nav-count">{runs.length || "—"}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="local-card">
              <span className="local-dot" />
              <strong>
                {cloud ? "Evidence that persists" : "Everything stays local"}
              </strong>
              <p>
                {cloud
                  ? "Isolated workers. Durable evidence. Review every outcome."
                  : "Inspect evidence and test the harness. No cloud upload."}
              </p>
            </div>
            <div className="version">
              <span>GAUNTLET</span>
              <span>workspace 0.9</span>
            </div>
          </div>
        </aside>
        <div className="workspace-main">
          <header className="topbar">
            <div className="breadcrumbs">
              <span>Workspace</span>
              <ChevronRight size={14} />
              <strong>
                {view === "runs"
                  ? "Evaluations"
                  : view === "tasks"
                    ? "Task suite"
                    : "Readiness"}
              </strong>
            </div>
            <div className="topbar-right">
              <span className="local-badge">
                <span className="local-dot" />
                {cloud ? "CLOUD" : "LOCAL"}
              </span>
              <span className="avatar">S</span>
            </div>
          </header>
          <main id="main" className="main-content">
            <AnimatePresence mode="wait">
              <motion.div
                key={view}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">COMPUTER-USE EVALUATIONS</p>
                    <h1>
                      {view === "runs"
                        ? "Every run. Every detail."
                        : view === "tasks"
                          ? "The proving ground."
                          : "Ready before you run."}
                    </h1>
                    <p className="page-subtitle">
                      {view === "runs"
                        ? "From first action to verified outcome."
                        : view === "tasks"
                          ? "Twelve tasks. Real applications. State-verified outcomes."
                          : "Check your environment before creating a desktop."}
                    </p>
                  </div>
                  <Button
                    className="primary-button"
                    onClick={() => {
                      setRerunSource(null);
                      setTaskPreset(null);
                      setDialogVersion((v) => v + 1);
                      setCreate(true);
                    }}
                  >
                    <Plus size={17} />
                    New evaluation
                  </Button>
                </div>
                {view === "runs" && (
                  <>
                    {cloud && (
                      <WorkspaceIntro
                        library={library}
                        onOpen={setSelected}
                        onCreate={() => {
                          setRerunSource(null);
                          setTaskPreset(null);
                          setDialogVersion((v) => v + 1);
                          setCreate(true);
                        }}
                        onReadiness={() => setView("readiness")}
                      />
                    )}
                    {cloud && (
                      <CloudJobs
                        revision={jobsRevision}
                        onOpen={setSelected}
                        onChange={refresh}
                      />
                    )}
                    <div className="metrics-grid">
                      <Metric
                        label="Saved evaluations"
                        value={library ? runs.length : "—"}
                        detail={
                          cloud
                            ? "From persistent cloud evidence"
                            : "From your local results folder"
                        }
                        icon={Layers3}
                      />
                      <Metric
                        label="Recorded trials"
                        value={library ? total : "—"}
                        detail="Includes diagnostic runs"
                        icon={Activity}
                      />
                      <Metric
                        label="Live evaluations"
                        value={library ? live.length : "—"}
                        detail={
                          live.length
                            ? "Real desktop sessions"
                            : "Awaiting first live validation"
                        }
                        icon={Monitor}
                      />
                      <Metric
                        label="Needs review"
                        value={library ? attention : "—"}
                        detail="Stopped, interrupted, or cleanup errors"
                        icon={CircleAlert}
                      />
                    </div>
                    <section className="first-live-panel">
                      <ShineBorder
                        shineColor={["#31533f", "#7aab86", "#31533f"]}
                        duration={18}
                      />
                      <div className="panel-icon">
                        <FlaskConical size={22} />
                      </div>
                      <div>
                        <div className="inline-heading">
                          <h2>Build confidence before going live</h2>
                          <Badge variant="outline" className="quiet-badge">
                            LOCAL DIAGNOSTICS
                          </Badge>
                        </div>
                        <p>
                          Dry runs validate the harness. They do not measure
                          model performance.
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        onClick={() => setView("readiness")}
                      >
                        Check readiness
                        <ArrowUpRight size={16} />
                      </Button>
                    </section>
                    <section className="runs-section">
                      <div className="section-heading">
                        <h2>
                          Evaluation runs <span>{runs.length}</span>
                        </h2>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={refreshing}
                          onClick={refresh}
                        >
                          <RefreshCw
                            size={15}
                            className={refreshing ? "animate-spin" : ""}
                          />
                          Refresh
                        </Button>
                      </div>
                      {error && (
                        <Notice tone="error">
                          {error}{" "}
                          {library && "Showing the last successful snapshot."}{" "}
                          <button className="text-link" onClick={refresh}>
                            Retry
                          </button>
                        </Notice>
                      )}
                      {!!library?.warnings.length && (
                        <details className="warning-details">
                          <summary>
                            {library.warnings.length} run folder
                            {library.warnings.length === 1 ? "" : "s"} need
                            attention
                          </summary>
                          {library.warnings.map((w) => (
                            <p key={w}>{w}</p>
                          ))}
                        </details>
                      )}
                      <div className="table-toolbar">
                        <div
                          className="filter-pills"
                          role="group"
                          aria-label="Filter runs"
                        >
                          {[
                            ["all", "All runs"],
                            ["dry-run", "Dry run"],
                            ["live", "Live"],
                            ["attention", "Needs review"],
                          ].map(([id, label]) => (
                            <button
                              key={id}
                              className={filter === id ? "selected" : ""}
                              onClick={() => setFilter(id)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <div className="search-field">
                          <Search size={16} />
                          <Input
                            aria-label="Search evaluations"
                            placeholder="Search evaluations…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                          />
                        </div>
                      </div>
                      {!library && !error ? (
                        <div
                          className="loading-rows"
                          aria-label="Loading evaluations"
                        >
                          {[1, 2, 3, 4].map((i) => (
                            <Skeleton key={i} className="h-16 w-full" />
                          ))}
                        </div>
                      ) : filtered.length ? (
                        <div className="table-scroll">
                          <table className="run-table">
                            <thead>
                              <tr>
                                <th>Evaluation</th>
                                <th>Status</th>
                                <th>Coverage</th>
                                <th>Pass rate</th>
                                <th>Created</th>
                                <th>
                                  <span className="sr-only">Open</span>
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {filtered.map((run) => (
                                <tr key={run.id}>
                                  <td>
                                    <button
                                      className="run-link"
                                      onClick={() => setSelected(run.id)}
                                    >
                                      <span className="run-icon">
                                        {run.recovery ? (
                                          <FileSearch size={18} />
                                        ) : (
                                          <Layers3 size={18} />
                                        )}
                                      </span>
                                      <span>
                                        <strong>{prettyName(run.id)}</strong>
                                        <small>
                                          {run.mode === "dry-run"
                                            ? "Static agent"
                                            : run.model}
                                          <span>·</span>
                                          {run.mode === "dry-run"
                                            ? "Dry run"
                                            : run.mode}
                                        </small>
                                      </span>
                                    </button>
                                  </td>
                                  <td>
                                    <Status status={run.status} />
                                  </td>
                                  <td>
                                    <span className="coverage-count">
                                      {run.recorded}
                                      <span> / {run.planned_trials}</span>
                                    </span>
                                    <div className="coverage-track">
                                      <span
                                        style={{
                                          width: `${Math.min(100, (run.recorded / Math.max(1, run.planned_trials)) * 100)}%`,
                                        }}
                                      />
                                    </div>
                                  </td>
                                  <td>
                                    {run.mode === "dry-run" ? (
                                      <span className="muted">Diagnostic</span>
                                    ) : (
                                      <span className="mono">
                                        {percent(passRate(run))}
                                      </span>
                                    )}
                                  </td>
                                  <td className="date-cell">
                                    {dateLabel(run.created_at)}
                                  </td>
                                  <td>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      aria-label={`Inspect ${run.id}`}
                                      onClick={() => setSelected(run.id)}
                                    >
                                      <ArrowUpRight size={17} />
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <Empty
                          title={
                            runs.length
                              ? "No matching evaluations"
                              : "Your next experiment starts here"
                          }
                        >
                          {runs.length
                            ? "Try another search or filter."
                            : "Create a credential-free dry run to test the full harness."}
                        </Empty>
                      )}
                      <div className="table-footer">
                        <span>
                          <Database size={13} />{" "}
                          {library
                            ? "Reading saved artifacts"
                            : "Connecting to saved artifacts"}
                        </span>
                        <span>
                          {library
                            ? `${filtered.length} evaluations shown`
                            : "No results loaded"}
                        </span>
                      </div>
                    </section>
                    <div className="bottom-grid">
                      <button
                        className="feature-link"
                        onClick={() => setView("tasks")}
                      >
                        <span className="feature-icon">
                          <Beaker size={20} />
                        </span>
                        <div>
                          <h3>A suite built for real work</h3>
                          <p>
                            Explore all 12 tasks, from simple edits to recovery.
                          </p>
                        </div>
                        <ArrowRight size={18} />
                      </button>
                      <button
                        className="feature-link"
                        onClick={() => setView("readiness")}
                      >
                        <span className="feature-icon violet">
                          <ShieldCheck size={20} />
                        </span>
                        <div>
                          <h3>Make the first live run count</h3>
                          <p>
                            Check dependencies, keys, and execution readiness.
                          </p>
                        </div>
                        <ArrowRight size={18} />
                      </button>
                    </div>
                  </>
                )}
                {view === "tasks" && (
                  <TaskSuite
                    onSelect={(id) => {
                      setRerunSource(null);
                      setTaskPreset(id);
                      setDialogVersion((v) => v + 1);
                      setCreate(true);
                    }}
                  />
                )}
                {view === "readiness" && <ReadinessPanel />}
              </motion.div>
            </AnimatePresence>
          </main>
          <footer className="workspace-footer">
            <span>Evidence over assumptions.</span>
            <span>
              <span className="local-dot" />{" "}
              {cloud
                ? "Cloud workspace · persistent evidence"
                : "Local workspace · no external telemetry"}
            </span>
          </footer>
        </div>
        <RunInspector
          key={selected || "none"}
          id={selected}
          runs={runs}
          onOpen={setSelected}
          onRerun={(run) => {
            setSelected(null);
            setRerunSource(run);
            setTaskPreset(null);
            setDialogVersion((v) => v + 1);
            setCreate(true);
          }}
          onClose={() => setSelected(null)}
        />
        <NewEvaluation
          cloud={cloud}
          onJobCreated={(job) => {
            setCreate(false);
            setView("runs");
            setJobsRevision((value) => value + 1);
            setToast(
              job.error ||
                `Job ${prettyName(job.status).toLowerCase()}. Track progress in Execution jobs.`,
            );
          }}
          key={dialogVersion}
          preset={taskPreset}
          source={rerunSource}
          open={create}
          onOpenChange={setCreate}
          onCreated={(id, warning) => {
            setCreate(false);
            void refresh();
            setSelected(id);
            setToast(
              warning || "Dry run saved. Its failed checks are expected.",
            );
          }}
        />
        <AnimatePresence>
          {toast && (
            <motion.div
              role="status"
              className="toast"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
            >
              <CheckCheck size={18} />
              {toast}
              <button
                aria-label="Dismiss notification"
                onClick={() => setToast("")}
              >
                <X size={16} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}

function TaskSuite({ onSelect }: { onSelect: (id: string) => void }) {
  return (
    <>
      <Notice>
        Outcomes are checked from saved machine state. Review the action trace
        to confirm how each task was completed.
      </Notice>
      <div className="task-grid">
        {TASK_IDS.map((id, i) => (
          <button className="task-card" key={id} onClick={() => onSelect(id)}>
            <div className="task-card-top">
              <span className="mono accent">{id}</span>
              <Badge variant="outline">Tier {i < 4 ? 1 : i < 8 ? 2 : 3}</Badge>
            </div>
            <span className="task-number">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h2>{TASK_NAMES[i]}</h2>
            <p>
              {i < 4
                ? "Foundational desktop interaction"
                : i < 8
                  ? "Multi-step application workflow"
                  : "Recovery, resilience, and safety"}
            </p>
            <span className="text-link">
              Add to an evaluation <ArrowUpRight size={14} />
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
const defaultSetup: RunSetup = {
  tasks: ["T01", "T02"],
  trials: 1,
  concurrency: 1,
  maxInfraFailures: 1,
  provider: "claude",
  modelId: "",
};
function ReadinessPanel() {
  const [setup, setSetup] = useState(defaultSetup);
  const [result, setResult] = useState<Readiness | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="readiness-layout">
      <section className="surface">
        <div className="section-heading">
          <h2>Local readiness</h2>
          <ShieldCheck size={20} />
        </div>
        <p className="muted">
          Checks credential presence, dependencies, and packaged fixtures. No
          authentication or paid requests.
        </p>
        <div className="form-grid">
          <label>
            Provider
            <Select
              disabled={busy}
              value={setup.provider}
              onValueChange={(v) => {
                setSetup({ ...setup, provider: v as RunSetup["provider"] });
                setResult(null);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Anthropic / Claude</SelectItem>
                <SelectItem value="openai">OpenAI</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label>
            Model ID
            <Input
              disabled={busy}
              placeholder={
                setup.provider === "claude"
                  ? "Use configured default"
                  : "Required for OpenAI"
              }
              value={setup.modelId}
              onChange={(e) => {
                setSetup({ ...setup, modelId: e.target.value });
                setResult(null);
              }}
            />
          </label>
        </div>
        <Button
          className="primary-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            setResult(null);
            try {
              setResult(
                await api("/api/preflight", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ setup, dryRun: false }),
                }),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <Loader2 className="animate-spin" size={16} />
          ) : (
            <ShieldCheck size={16} />
          )}
          Check environment
        </Button>
        {error && <Notice tone="error">{error}</Notice>}
        {result && (
          <div className="check-results">
            <h3>
              {result.ready
                ? "Local checks passed"
                : "Resolve these checks before a live run"}
            </h3>
            {result.checks.map((c) => (
              <div className="check-row" key={c.name}>
                {c.status === "pass" ? (
                  <CircleCheck size={16} className="accent" />
                ) : (
                  <CircleAlert size={16} className="amber" />
                )}
                <div>
                  <strong>{prettyName(c.name)}</strong>
                  <p>{c.message}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="surface setup-guide">
        <span className="panel-icon">
          <Terminal size={24} />
        </span>
        <h2>Keep your keys in your environment.</h2>
        <p>
          This workspace never asks you to paste a secret. Configure credentials
          in the terminal that starts the app, then check readiness again.
        </p>
        <div className="guide-step">
          <span>01</span>
          <div>
            <strong>Connect Solari</strong>
            <code>SOLARI_API_KEY</code>
          </div>
        </div>
        <div className="guide-step">
          <span>02</span>
          <div>
            <strong>Choose one provider</strong>
            <code>ANTHROPIC_API_KEY or OPENAI_API_KEY</code>
          </div>
        </div>
        <div className="guide-step">
          <span>03</span>
          <div>
            <strong>Start small</strong>
            <p>T01 + T02 · 1 trial · concurrency 1</p>
          </div>
        </div>
        <Notice>
          Local checks cannot validate account access, model compatibility, or
          the desktop template.
        </Notice>
      </section>
    </div>
  );
}
function NewEvaluation({
  cloud,
  onJobCreated,
  open,
  onOpenChange,
  onCreated,
  preset,
  source,
}: {
  cloud: boolean;
  onJobCreated: (job: PublicCloudJob) => void;
  source: Run | null;
  preset: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (id: string, warning?: string) => void;
}) {
  const [setup, setSetup] = useState<RunSetup>(
    source
      ? {
          ...defaultSetup,
          tasks: source.task_ids.filter((id) => TASK_IDS.includes(id)),
          trials: Math.min(3, source.trials_per_task),
          concurrency: Math.min(
            2,
            Math.max(1, Number(source.configuration.concurrency) || 1),
          ),
          maxInfraFailures: Math.min(
            3,
            Math.max(1, Number(source.configuration.max_infra_failures) || 1),
          ),
          provider:
            source.configuration.adapter === "openai" ? "openai" : "claude",
          modelId: source.mode === "live" ? source.model : "",
        }
      : preset
        ? { ...defaultSetup, tasks: [preset] }
        : defaultSetup,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const command = liveCommand(setup);
  async function launchCloud(mode: "dry-run" | "live") {
    setBusy(true);
    setError("");
    try {
      const result = await api<PublicCloudJob>("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setup,
          mode,
          ...(source ? { parentId: source.id } : {}),
        }),
      });
      onJobCreated(result);
    } catch (e) {
      setError(
        (e as Error).message +
          " Check Execution jobs before trying again; a disconnected request may still be running.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) onOpenChange(v);
      }}
    >
      <DialogContent className="evaluation-dialog">
        <DialogHeader>
          <div className="dialog-icon">
            <FlaskConical size={23} />
          </div>
          <DialogTitle>New evaluation</DialogTitle>
          <DialogDescription>
            {cloud
              ? "Run diagnostics or launch a live evaluation in an isolated cloud worker."
              : "Start with a local dry run, or prepare your live command."}
          </DialogDescription>
        </DialogHeader>
        {source && (
          <Notice>
            {cloud ? "This evaluation" : "Local diagnostics"} will create an
            attempt linked to {source.id}.
            {!cloud &&
              " Copied live commands create independent runs without an automatic link."}{" "}
            Task selection and supported limits are copied into this form;
            current task code is used. Environment, pricing and other advanced
            settings are not copied. Review the configuration before running.
          </Notice>
        )}
        <SavedSetups setup={setup} onLoad={setSetup} disabled={busy} />
        <Tabs defaultValue="dry">
          <TabsList className="w-full">
            <TabsTrigger value="dry" className="flex-1">
              Dry run
            </TabsTrigger>
            <TabsTrigger value="live" className="flex-1">
              {cloud ? "Live evaluation" : "Live command"}
            </TabsTrigger>
          </TabsList>
          <fieldset disabled={busy}>
            <div className="section-heading mini">
              <h3>Select tasks</h3>
              <button
                className="text-link"
                onClick={() =>
                  setSetup({
                    ...setup,
                    tasks:
                      setup.tasks.length === 12 ? ["T01", "T02"] : TASK_IDS,
                  })
                }
              >
                {setup.tasks.length === 12 ? "Use smoke test" : "Select all"}
              </button>
            </div>
            <div className="task-select-grid">
              {TASK_IDS.map((id, i) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={setup.tasks.includes(id)}
                  title={TASK_NAMES[i]}
                  className={setup.tasks.includes(id) ? "chosen" : ""}
                  onClick={() =>
                    setSetup({
                      ...setup,
                      tasks: setup.tasks.includes(id)
                        ? setup.tasks.filter((t) => t !== id)
                        : [...setup.tasks, id].sort(),
                    })
                  }
                >
                  {id}
                  {setup.tasks.includes(id) && <Check size={12} />}
                </button>
              ))}
            </div>
            <div className="form-grid three">
              {(
                [
                  ["trials", "Trials", 3],
                  ["concurrency", "Concurrency", 2],
                  ["maxInfraFailures", "Failure limit", 3],
                ] as const
              ).map(([key, label, max]) => (
                <label key={key}>
                  {label}
                  <Select
                    value={String(setup[key])}
                    onValueChange={(v) =>
                      setSetup({ ...setup, [key]: Number(v) })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: max }, (_, i) => (
                        <SelectItem key={i} value={String(i + 1)}>
                          {i + 1}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="plan-line">
            <Layers3 size={16} />
            <strong>{setup.tasks.length * setup.trials} planned trials</strong>
            <span>·</span>
            {setup.tasks.length} tasks
          </div>
          <TabsContent value="dry">
            <Notice>
              No desktops, model requests, or credentials. The static agent
              stops immediately, so state checks are expected to fail.
            </Notice>
            {error && <Notice tone="error">{error}</Notice>}
            <Button
              className="primary-button w-full"
              disabled={busy || !setup.tasks.length}
              onClick={async () => {
                if (cloud) return launchCloud("dry-run");
                setBusy(true);
                setError("");
                try {
                  const r = await api<{
                    id: string | null;
                    ok: boolean;
                    message: string;
                    warning?: string;
                  }>(
                    source
                      ? `/api/runs/${encodeURIComponent(source.id)}/rerun`
                      : "/api/dry-run",
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(setup),
                    },
                  );
                  if (r.id && r.ok) onCreated(r.id, r.warning);
                  else
                    setError(
                      r.message +
                        (r.id
                          ? ` Saved run: ${r.id}. Close this dialog and refresh to inspect it.`
                          : ""),
                    );
                } catch (e) {
                  setError(
                    (e as Error).message +
                      " Refresh the run library before retrying; a disconnected request may have saved results.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <FlaskConical size={16} />
              )}{" "}
              {busy
                ? cloud
                  ? "Starting worker…"
                  : "Running local diagnostics…"
                : cloud
                  ? "Run cloud diagnostics"
                  : "Run local diagnostics"}
            </Button>
          </TabsContent>
          <TabsContent value="live">
            <div className="form-grid">
              <label>
                Provider
                <Select
                  disabled={busy}
                  value={setup.provider}
                  onValueChange={(v) =>
                    setSetup({ ...setup, provider: v as RunSetup["provider"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label>
                Model ID
                <Input
                  disabled={busy}
                  value={setup.modelId}
                  onChange={(e) =>
                    setSetup({ ...setup, modelId: e.target.value })
                  }
                  placeholder="Configured default"
                />
              </label>
            </div>
            <Notice tone="warning">
              {cloud
                ? "Uses the provider credentials configured on the server. Starting a live evaluation creates billable desktops and model requests."
                : "Run this from the project root after configuring credentials. Live commands create billable desktops and model requests."}
            </Notice>
            {cloud && (
              <CloudLiveLaunch
                setup={setup}
                busy={busy}
                onLaunch={() => void launchCloud("live")}
              />
            )}
            {cloud && (
              <p className="mt-4 mb-2 text-xs text-muted-foreground">
                Terminal fallback for a separately configured local
                installation:
              </p>
            )}
            <pre className="command-preview">{command}</pre>
            <Button
              variant="outline"
              className="w-full"
              disabled={!setup.tasks.length}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(command);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2500);
                } catch {
                  setError(
                    "Clipboard unavailable. Select and copy the command above.",
                  );
                }
              }}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
              {copied ? "Copied" : "Copy live command"}
            </Button>
            {error && <Notice tone="error">{error}</Notice>}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
function RunInspector({
  id,
  runs,
  onOpen,
  onRerun,
  onClose,
}: {
  id: string | null;
  runs: RunCard[];
  onOpen: (id: string) => void;
  onRerun: (run: Run) => void;
  onClose: () => void;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const [trial, setTrial] = useState<Trial | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditError, setAuditError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setRun(null);
    setTrial(null);
    setAudit(null);
    setError("");
    setAuditError("");
    setAuditing(false);
    if (!id) return;
    const ctrl = new AbortController();
    api<Run>(`/api/runs/${encodeURIComponent(id)}`, { signal: ctrl.signal })
      .then(setRun)
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(e.message);
      });
    return () => ctrl.abort();
  }, [id, attempt]);
  const activeId = useRef(id);
  activeId.current = id;
  const card = run ? summarizeRun(run) : null;
  return (
    <Dialog
      open={!!id}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="inspector-dialog">
        <DialogHeader>
          <p className="eyebrow">EVALUATION DETAIL</p>
          <DialogTitle>
            {run ? prettyName(run.id) : "Loading evaluation"}
          </DialogTitle>
          <DialogDescription>
            {run
              ? `${run.model} · ${dateLabel(run.created_at)}`
              : "Reading saved artifacts from your workspace."}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Notice tone="error">
            {error}{" "}
            <button
              className="text-link"
              onClick={() => setAttempt((v) => v + 1)}
            >
              Retry
            </button>
          </Notice>
        )}
        {!run && !error && <Skeleton className="h-60 w-full" />}
        {run && card && (
          <>
            <div className="inspector-meta">
              <Button size="sm" variant="outline" onClick={() => onRerun(run)}>
                Prepare another attempt
              </Button>
              <Status status={run.status} />
              <Badge variant="outline">{run.mode}</Badge>
              <span>
                {run.records.length} / {run.planned_trials} trials
              </span>
              <Button size="sm" variant="ghost" asChild>
                <a href={`/api/runs/${run.id}/export`} download>
                  <ArrowDownToLine size={14} />
                  Download manifest
                </a>
              </Button>
            </div>
            {run.mode === "dry-run" && (
              <Notice>
                Dry-run diagnostics. Failed checks are expected and are not
                model benchmark scores.
              </Notice>
            )}
            {run.status === "running" && (
              <Notice tone="warning">
                The saved status is “running.” This does not confirm that its
                process is still active. Refresh or audit the run.
              </Notice>
            )}
            {run.stop_reason && (
              <Notice tone="warning">
                Failure limit {run.stop_reason.limit} reached at{" "}
                {run.stop_reason.task_id}/{run.stop_reason.trial}. Queued trials
                stopped; missing coverage remains in the original plan.
              </Notice>
            )}
            {run.recovery && (
              <Notice>
                Recovered local snapshot. Missing trials and cleanup uncertainty
                remain; recovery did not rerun tasks.
              </Notice>
            )}
            <Tabs defaultValue="trials">
              <TabsList className="flex h-auto flex-wrap">
                <TabsTrigger value="trials">Trial matrix</TabsTrigger>
                <TabsTrigger value="audit">Artifact audit</TabsTrigger>
                <TabsTrigger value="configuration">Configuration</TabsTrigger>
                <TabsTrigger value="assessment">Compare & gate</TabsTrigger>
                <TabsTrigger value="attempts">Attempt history</TabsTrigger>
              </TabsList>
              <TabsContent value="trials">
                <div className="trial-matrix">
                  {run.task_ids.map((task) => (
                    <div className="matrix-row" key={task}>
                      <div>
                        <span className="mono accent">{task}</span>
                        <strong>
                          {run.tasks[task]?.definition.name.replace(
                            /_/g,
                            " ",
                          ) ||
                            TASK_NAMES[TASK_IDS.indexOf(task)] ||
                            "Task"}
                        </strong>
                      </div>
                      <div className="matrix-dots">
                        {Array.from(
                          { length: Math.min(run.trials_per_task, 100) },
                          (_, i) => {
                            const record = run.records.find(
                              (r) => r.task_id === task && r.trial === i + 1,
                            );
                            return (
                              <button
                                key={i}
                                disabled={!record}
                                title={
                                  record
                                    ? `${task}/${i + 1}: ${verdict(record)}. Open evidence.`
                                    : `${task}/${i + 1}: no saved result`
                                }
                                aria-label={`${task} trial ${i + 1}: ${record ? verdict(record) : "missing"}`}
                                className={cn(
                                  "trial-dot",
                                  record ? verdict(record) : "missing",
                                  trial === record && "selected",
                                )}
                                onClick={() => setTrial(record!)}
                              >
                                {i + 1}
                              </button>
                            );
                          },
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {run.trials_per_task > 100 && (
                  <Notice>
                    Showing the first 100 trial slots per task. Download the
                    snapshot for the full plan.
                  </Notice>
                )}
                <div className="matrix-legend">
                  <span>
                    <i className="pass" />
                    Passed
                  </span>
                  <span>
                    <i className="fail" />
                    Failed
                  </span>
                  <span>
                    <i className="infra" />
                    Infrastructure
                  </span>
                  <span>
                    <i className="missing" />
                    Missing
                  </span>
                </div>
                {trial ? (
                  <TrialEvidence
                    key={`${run.id}/${trial.task_id}/${trial.trial}`}
                    run={run}
                    trial={trial}
                  />
                ) : (
                  <div className="evidence-prompt">
                    <FileSearch size={20} />
                    Select a recorded trial to inspect its evidence.
                  </div>
                )}
              </TabsContent>
              <TabsContent value="audit">
                <p className="muted mb-4">
                  Read-only inspection of local records and lifecycle evidence.
                  Remote desktop status is not queried.
                </p>
                <Button
                  variant="outline"
                  disabled={auditing}
                  onClick={async () => {
                    setAuditing(true);
                    setAuditError("");
                    const target = id;
                    try {
                      const result = await api<Audit>(`/api/runs/${id}/audit`);
                      if (activeId.current === target) setAudit(result);
                    } catch (e) {
                      if (activeId.current === target)
                        setAuditError((e as Error).message);
                    } finally {
                      if (activeId.current === target) setAuditing(false);
                    }
                  }}
                >
                  {auditing ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <ShieldCheck size={16} />
                  )}
                  Audit artifacts
                </Button>
                {auditError && <Notice tone="error">{auditError}</Notice>}
                {audit && (
                  <div className="audit-results">
                    <Notice tone={audit.healthy ? "info" : "warning"}>
                      {audit.healthy
                        ? "No local inconsistencies found. A clean audit does not mean tasks passed."
                        : `${audit.findings.length} findings need review. No artifacts or desktops were changed.`}
                    </Notice>
                    <div className="audit-counts">
                      {Object.entries(audit.counts).map(([k, v]) => (
                        <div key={k}>
                          <strong>{v}</strong>
                          <span>{prettyName(k)}</span>
                        </div>
                      ))}
                    </div>
                    {audit.findings.map((f, i) => (
                      <div key={i} className="check-row">
                        <TriangleAlert size={16} className="amber" />
                        <div>
                          <strong>{prettyName(f.code)}</strong>
                          <p>{f.message}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
              <TabsContent value="assessment">
                <RunAssessment key={run.id} run={run} runs={runs} />
              </TabsContent>
              <TabsContent value="attempts">
                <AttemptHistory id={run.id} onOpen={onOpen} />
              </TabsContent>
              <TabsContent value="configuration">
                <pre className="json-block">
                  {JSON.stringify(
                    {
                      configuration: run.configuration,
                      stop_reason: run.stop_reason,
                      recovery: run.recovery,
                    },
                    null,
                    2,
                  )}
                </pre>
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
