"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, Loader2, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { api } from "@/lib/client";
import { dateLabel, prettyName } from "@/lib/domain";
import { jobLibrarySignature, jobPollingDelay } from "@/lib/job-polling";
import type { PublicCloudJob } from "@/lib/cloud-runner";
import type { CloudJobList } from "@/lib/cloud-job-list";
import {
  mergeJobs,
  mergeJobPage,
  refreshUntrackedJobs,
  visibleJobs,
} from "@/lib/job-pagination";

export function CloudJobs({
  revision,
  onOpen,
  onChange,
}: {
  revision: number;
  onOpen: (id: string) => void;
  onChange: () => void;
}) {
  const [reserved, setReserved] = useState<PublicCloudJob[]>([]);
  const [history, setHistory] = useState<CloudJobList | null>(null);
  const jobs = mergeJobs(history?.jobs ?? [], reserved);
  const observedJobs = useRef<PublicCloudJob[]>([]);
  observedJobs.current = jobs;
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(6);
  const displayed = visibleJobs(jobs, historyVisible);
  const historyRequest = useRef<AbortController | null>(null);
  const historyGeneration = useRef(0);
  const historyCursors = useRef(new Set<string>());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [trackingKnown, setTrackingKnown] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [stopping, setStopping] = useState<string[]>([]);
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({});
  async function stop(id: string) {
    setStopping((ids) => [...ids, id]);
    setStopErrors((errors) => ({ ...errors, [id]: "" }));
    try {
      const updated = await api<PublicCloudJob>(`/api/jobs/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      setReserved((previous) => mergeJobs(previous, [updated]));
      setHistory((previous) =>
        previous
          ? { ...previous, jobs: mergeJobs(previous.jobs, [updated]) }
          : previous,
      );
    } catch (error) {
      setStopErrors((errors) => ({
        ...errors,
        [id]: `${(error as Error).message} Refresh status before retrying; the stop request may have been saved.`,
      }));
    } finally {
      setStopping((ids) => ids.filter((value) => value !== id));
      // A failed response can still mean the stop was accepted. Re-read status;
      // never replay cancellation automatically.
      setRefresh((value) => value + 1);
    }
  }
  const signature = useRef("");
  const pollingDelay = useRef(jobPollingDelay(null));
  useEffect(() => {
    let disposed = false;
    let request: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshAfterRequest = false;
    function clearTimer() {
      clearTimeout(timer);
      timer = undefined;
    }
    async function poll() {
      clearTimer();
      if (disposed || document.hidden) return;
      if (request) {
        // Visibility may return before the hidden request has finished aborting.
        refreshAfterRequest = true;
        return;
      }
      const abort = new AbortController();
      request = abort;
      try {
        const snapshot = await api<CloudJobList>("/api/jobs?view=reserved", {
          signal: abort.signal,
        });
        const observed = observedJobs.current;
        const data = await refreshUntrackedJobs(observed, snapshot, (id) => {
          abort.signal.throwIfAborted();
          return api<PublicCloudJob>(`/api/jobs/${id}`, {
            signal: abort.signal,
          });
        });
        if (disposed || abort.signal.aborted) return;
        const next = jobLibrarySignature(data.jobs);
        if (signature.current && next !== signature.current) onChange();
        signature.current = next;
        pollingDelay.current = jobPollingDelay(data);
        // Keep new observations in already loaded history, but never use an
        // archive cursor or a partial history page to infer current execution.
        const operationalIds = new Set([
          ...snapshot.jobs.map((job) => job.id),
          ...observed
            .filter((job) => jobPollingDelay({ jobs: [job] }) === 10_000)
            .map((job) => job.id),
        ]);
        setReserved((previous) =>
          mergeJobs(
            previous,
            data.jobs.filter((job) => operationalIds.has(job.id)),
          ),
        );
        setHistory((previous) =>
          previous
            ? {
                ...previous,
                jobs: mergeJobs(previous.jobs, data.jobs),
              }
            : previous,
        );
        setWarnings(data.warnings ?? []);
        setTrackingKnown(data.reservations?.known === true);
        setLoaded(true);
        setError("");
      } catch (e) {
        if (!disposed && !abort.signal.aborted) {
          pollingDelay.current = jobPollingDelay(null);
          setError((e as Error).message);
        }
      } finally {
        request = null;
        if (!disposed && !document.hidden) {
          if (refreshAfterRequest) {
            refreshAfterRequest = false;
            void poll();
          } else timer = setTimeout(poll, pollingDelay.current);
        }
      }
    }
    function visibilityChanged() {
      clearTimer();
      if (document.hidden) {
        refreshAfterRequest = false;
        request?.abort();
      } else void poll();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    void poll();
    return () => {
      disposed = true;
      request?.abort();
      clearTimer();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [revision, refresh, onChange]);
  useEffect(() => {
    const generation = ++historyGeneration.current;
    historyCursors.current.clear();
    setHistoryVisible(6);
    setReserved((previous) =>
      previous.filter((job) => jobPollingDelay({ jobs: [job] }) === 10_000),
    );
    historyRequest.current?.abort();
    const abort = new AbortController();
    historyRequest.current = abort;
    setHistoryLoading(true);
    setHistoryError("");
    void api<CloudJobList>("/api/jobs?limit=25", { signal: abort.signal })
      .then((data) => {
        if (!abort.signal.aborted && generation === historyGeneration.current)
          setHistory(data);
      })
      .catch((error: Error) => {
        if (!abort.signal.aborted && generation === historyGeneration.current)
          setHistoryError(error.message);
      })
      .finally(() => {
        if (generation === historyGeneration.current) {
          historyRequest.current = null;
          setHistoryLoading(false);
        }
      });
    return () => {
      abort.abort();
      historyRequest.current?.abort();
    };
  }, [revision, refresh]);

  async function loadMore() {
    const cursor = history?.page?.nextCursor;
    if (!cursor || historyRequest.current) return;
    const generation = historyGeneration.current;
    const abort = new AbortController();
    historyRequest.current = abort;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const data = await api<CloudJobList>(
        `/api/jobs?${new URLSearchParams({ limit: "25", cursor })}`,
        { signal: abort.signal },
      );
      if (abort.signal.aborted || generation !== historyGeneration.current)
        return;
      if (
        data.page?.nextCursor &&
        (data.page.nextCursor === cursor ||
          historyCursors.current.has(data.page.nextCursor))
      )
        throw new Error(
          "Job history did not advance. Refresh before continuing.",
        );
      historyCursors.current.add(cursor);
      setHistory((previous) => mergeJobPage(previous, data));
    } catch (error) {
      if (!abort.signal.aborted && generation === historyGeneration.current)
        setHistoryError((error as Error).message);
    } finally {
      if (generation === historyGeneration.current) {
        historyRequest.current = null;
        setHistoryLoading(false);
      }
    }
  }
  const allWarnings = [...new Set([...warnings, ...(history?.warnings ?? [])])];
  return (
    <section
      className="mb-6 rounded-xl border bg-card p-5"
      aria-label="Execution jobs"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity size={18} />
          <h2 className="font-semibold">Execution jobs</h2>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Refresh execution jobs"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={15} />
        </Button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Workers continue after you close this page. Evidence appears as it is
        saved. Job completion does not mean every task passed.
      </p>
      <p className="mb-4 text-xs text-muted-foreground">
        Current executions refresh independently of history every 10 seconds
        while active or uncertain, and every minute when confirmed idle.
        Automatic status refresh pauses while this tab is hidden. Refresh
        restarts job history from its first page.
      </p>
      {error && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error} Previously loaded jobs are retained. Check status before
          starting another attempt.
        </p>
      )}
      {historyError && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {historyError} Previously loaded history is retained. Retry loading or
          refresh.
        </p>
      )}
      {loaded && !trackingKnown && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          Current execution tracking is incomplete. The loaded history cannot
          establish that the workspace is idle.
        </p>
      )}
      {allWarnings.length > 0 && (
        <div
          role="status"
          className="mb-3 rounded-lg border p-3 text-sm text-muted-foreground"
        >
          <p>
            Some job entries could not be loaded. Available jobs remain below.
          </p>
          <ul className="mt-2 space-y-1">
            {allWarnings.slice(0, 3).map((warning) => (
              <li key={warning} className="break-words">
                {warning}
              </li>
            ))}
          </ul>
          {allWarnings.length > 3 && (
            <p className="mt-2">
              {allWarnings.length - 3} more job warnings. Refresh to retry
              loading.
            </p>
          )}
        </div>
      )}
      {history?.page?.nextCursor && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          More job history is available. Jobs are sorted within the loaded
          entries; current tracked executions are included independently.
        </p>
      )}
      {!loaded && !history && !error && !historyError && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" />
          Loading jobs…
        </p>
      )}
      {loaded && history && jobs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {allWarnings.length || history?.truncated
            ? "No readable jobs in this listing. Refresh status before starting another attempt."
            : "No jobs yet. Create an evaluation to run the harness in an isolated worker."}
        </p>
      )}
      <div className="space-y-3">
        {displayed.jobs.map((job) => (
          <article key={job.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{prettyName(job.status)}</Badge>
                  <span className="text-sm font-medium">
                    {job.mode === "live"
                      ? "Live evaluation"
                      : "Dry-run diagnostics"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {job.setup.tasks.length * job.setup.trials} trials
                  </span>
                </div>
                <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                  {job.id}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {dateLabel(job.createdAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {job.controlVersion === 1 &&
                  ["starting", "running", "interrupted"].includes(job.status) &&
                  Date.parse(job.expiresAt) > Date.now() && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={stopping.includes(job.id)}
                      onClick={() => void stop(job.id)}
                    >
                      {stopping.includes(job.id)
                        ? "Requesting stop…"
                        : "Stop evaluation"}
                    </Button>
                  )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onOpen(job.id)}
                >
                  Inspect saved evidence
                </Button>
              </div>
            </div>
            {job.status === "cancelling" && (
              <p role="status" className="mt-3 text-sm text-muted-foreground">
                Stop requested. Waiting for the worker to finish cleanup and
                save partial evidence. This can take several minutes.
              </p>
            )}
            {job.status === "cancelled" && (
              <p className="mt-3 text-sm text-muted-foreground">
                The worker acknowledged cancellation. Check saved lifecycle
                records for remote desktop cleanup; cancellation alone does not
                confirm deletion.
              </p>
            )}
            {stopErrors[job.id] && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {stopErrors[job.id]}
              </p>
            )}
            {job.error && (
              <p className="mt-3 text-sm text-destructive">{job.error}</p>
            )}
            {job.parentId && (
              <p className="mt-2 break-all text-xs text-muted-foreground">
                New attempt from {job.parentId}
              </p>
            )}
          </article>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Showing {displayed.jobs.length} of {jobs.length} loaded jobs.
          {displayed.current > 0
            ? ` All ${displayed.current} active or uncertain jobs are shown first.`
            : " Delivery history is retained."}
        </p>
        <div className="flex flex-wrap gap-2">
          {displayed.remaining > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setHistoryVisible((value) => value + 6)}
            >
              Show more loaded jobs ({displayed.remaining} remaining)
            </Button>
          )}
          {history?.page?.nextCursor && (
            <Button
              size="sm"
              variant="outline"
              disabled={historyLoading}
              onClick={() => void loadMore()}
            >
              {historyLoading ? (
                <Loader2 size={15} className="animate-spin" />
              ) : null}
              {historyLoading ? "Loading history…" : "Load more jobs"}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
