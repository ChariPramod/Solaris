"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, Loader2, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { api } from "@/lib/client";
import { dateLabel, prettyName } from "@/lib/domain";
import type { PublicCloudJob } from "@/lib/cloud-runner";
import type { CloudJobList } from "@/lib/cloud-job-list";

export function CloudJobs({
  revision,
  onOpen,
  onChange,
}: {
  revision: number;
  onOpen: (id: string) => void;
  onChange: () => void;
}) {
  const [jobs, setJobs] = useState<PublicCloudJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
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
      setJobs((previous) =>
        previous.map((job) => (job.id === id ? updated : job)),
      );
      setRefresh((value) => value + 1);
    } catch (error) {
      setStopErrors((errors) => ({
        ...errors,
        [id]: `${(error as Error).message} Refresh status before retrying; the stop request may have been saved.`,
      }));
    } finally {
      setStopping((ids) => ids.filter((value) => value !== id));
    }
  }
  const signature = useRef("");
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api<CloudJobList>("/api/jobs", {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        const next = JSON.stringify(
          data.jobs.map((job) => [job.id, job.updatedAt, job.status]),
        );
        if (signature.current && next !== signature.current) onChange();
        signature.current = next;
        setJobs(data.jobs);
        setWarnings(data.warnings ?? []);
        setTruncated(data.truncated ?? false);
        setLoaded(true);
        setError("");
      } catch (e) {
        if (!abort.signal.aborted) setError((e as Error).message);
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(poll, 10_000);
      }
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [revision, refresh, onChange]);
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
      {error && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error} Previously loaded jobs are retained. Check status before
          starting another attempt.
        </p>
      )}
      {warnings.length > 0 && (
        <div
          role="status"
          className="mb-3 rounded-lg border p-3 text-sm text-muted-foreground"
        >
          <p>
            Some job entries could not be loaded. Available jobs remain below.
          </p>
          <ul className="mt-2 space-y-1">
            {warnings.slice(0, 3).map((warning) => (
              <li key={warning} className="break-words">
                {warning}
              </li>
            ))}
          </ul>
          {warnings.length > 3 && (
            <p className="mt-2">
              {warnings.length - 3} more job warnings. Refresh to retry loading.
            </p>
          )}
        </div>
      )}
      {truncated && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          The job listing reached its 200-entry limit. This is a partial
          archive, sorted within the loaded entries.
        </p>
      )}
      {!loaded && !error && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" />
          Loading jobs…
        </p>
      )}
      {loaded && jobs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {warnings.length || truncated
            ? "No readable jobs in this listing. Refresh status before starting another attempt."
            : "No jobs yet. Create an evaluation to run the harness in an isolated worker."}
        </p>
      )}
      <div className="space-y-3">
        {jobs.slice(0, 12).map((job) => (
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
      {jobs.length > 12 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the latest 12 loaded jobs. Saved evaluations remain in the
          library.
        </p>
      )}
    </section>
  );
}
