"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, Loader2, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { api } from "@/lib/client";
import { dateLabel, prettyName } from "@/lib/domain";
import type { PublicCloudJob } from "@/lib/cloud-runner";

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
  const [refresh, setRefresh] = useState(0);
  const signature = useRef("");
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api<{ jobs: PublicCloudJob[] }>("/api/jobs", {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        const next = JSON.stringify(
          data.jobs.map((job) => [job.id, job.updatedAt, job.status]),
        );
        if (signature.current && next !== signature.current) onChange();
        signature.current = next;
        setJobs(data.jobs);
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
      {!loaded && !error && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" />
          Loading jobs…
        </p>
      )}
      {loaded && jobs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No jobs yet. Create an evaluation to run the harness in an isolated
          worker.
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
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpen(job.id)}
              >
                Inspect saved evidence
              </Button>
            </div>
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
          Showing the latest 12 jobs. Saved evaluations remain in the library.
        </p>
      )}
    </section>
  );
}
