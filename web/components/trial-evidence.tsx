"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cpu,
  FileCode2,
  Loader2,
  Monitor,
  Pause,
  Play,
  Save,
  ShieldCheck,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { prettyName } from "@/lib/domain";
import { buildPlayback, clickPosition } from "@/lib/playback";
import {
  reviewDrafts,
  type ReviewDraft,
  type DraftBase,
} from "@/lib/review-drafts";
import type { Run, Trial, TrialDetail } from "@/lib/types";

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(40000)])
    : AbortSignal.timeout(40000);
  const response = await fetch(url, { ...options, signal, cache: "no-store" });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(data?.error || `Request failed (${response.status}).`);
  if (!data)
    throw new Error(
      "The server returned an unreadable response. Your saved evidence is unchanged.",
    );
  return data as T;
}

function Notice({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`notice ${error ? "notice-error" : "notice-warning"}`}
      role={error ? "alert" : "status"}
    >
      <TriangleAlert size={16} />
      <div>{children}</div>
    </div>
  );
}

export function TrialEvidence({ run, trial }: { run: Run; trial: Trial }) {
  return (
    <Evidence
      key={`${run.id}/${trial.task_id}/${trial.trial}`}
      run={run}
      trial={trial}
    />
  );
}

function Evidence({ run, trial }: { run: Run; trial: Trial }) {
  const [detail, setDetail] = useState<TrialDetail | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [intervalMs, setIntervalMs] = useState(1500);
  const [failedImage, setFailedImage] = useState("");
  const [dimensions, setDimensions] = useState({
    src: "",
    width: 0,
    height: 0,
  });
  const endpoint = `/api/runs/${run.id}/trials/${trial.task_id}/${trial.trial}`;
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    request<TrialDetail>(endpoint, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) {
          setDetail(data);
          setIndex(0);
          setPlaying(false);
        }
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [endpoint, attempt]);
  const frames = useMemo(
    () => (detail ? buildPlayback(detail.frames, detail.screenshots) : []),
    [detail],
  );
  useEffect(() => {
    if (!playing) return;
    if (index >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(
      () => setIndex((current) => current + 1),
      intervalMs,
    );
    return () => clearTimeout(timer);
  }, [playing, index, frames.length, intervalMs]);
  const frame = frames[index];
  const src =
    frame?.screenshot && frame.available
      ? `/api/runs/${run.id}/artifact?task=${trial.task_id}&trial=${trial.trial}&name=${encodeURIComponent(frame.screenshot)}`
      : "";
  const imageReady = dimensions.src === src;
  const marker = imageReady
    ? clickPosition(frame?.action, dimensions.width, dimensions.height)
    : null;
  const selectFrame = (next: number) => {
    setPlaying(false);
    setIndex(Math.max(0, Math.min(frames.length - 1, next)));
  };
  return (
    <section className="evidence-section">
      <div className="section-heading">
        <h3>
          {trial.task_id} <span className="muted">/ Trial {trial.trial}</span>
        </h3>
        <Badge variant="outline" className={trial.passed ? "accent" : "amber"}>
          {trial.failure_class
            ? prettyName(trial.failure_class)
            : trial.passed
              ? "Passed"
              : "Failed"}
        </Badge>
      </div>
      <div className="evidence-stats">
        <span>
          <Activity size={14} />
          {trial.steps} steps
        </span>
        <span>
          <Clock3 size={14} />
          {trial.wall_seconds.toFixed(2)}s
        </span>
        <span>
          <Cpu size={14} />
          {trial.tokens_in + trial.tokens_out} tokens
        </span>
        <span>
          <ShieldCheck size={14} />
          {trial.cleanup_error ? "Cleanup error" : "No recorded cleanup error"}
        </span>
      </div>
      {trial.error && (
        <Notice>
          Execution{" "}
          {trial.failure_stage
            ? `failed during ${prettyName(trial.failure_stage)}`
            : "reported an error"}
          . {trial.error}
        </Notice>
      )}
      {trial.cleanup_error && <Notice error>{trial.cleanup_error}</Notice>}
      {error && (
        <Notice error>
          {error}{" "}
          <button
            className="text-link"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Reload evidence
          </button>
        </Notice>
      )}
      {!detail && !error && <Skeleton className="h-40 w-full" />}
      {detail && (
        <>
          <div className="evidence-columns">
            <div>
              <div
                className="screenshot-frame relative"
                style={
                  imageReady && dimensions.height
                    ? {
                        aspectRatio: `${dimensions.width}/${dimensions.height}`,
                      }
                    : undefined
                }
              >
                {src && failedImage !== src ? (
                  <>
                    <img
                      key={src}
                      src={src}
                      alt={`${trial.task_id} trial ${trial.trial}, ${frame.label}`}
                      onLoad={(event) =>
                        setDimensions({
                          src,
                          width: event.currentTarget.naturalWidth,
                          height: event.currentTarget.naturalHeight,
                        })
                      }
                      onError={() => setFailedImage(src)}
                    />
                    {marker && (
                      <span
                        aria-label={`Requested click at ${Math.round(marker.left * 12.8)}, ${Math.round(marker.top * 7.2)}`}
                        className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-amber-400/40 shadow-[0_0_0_3px_rgba(0,0,0,0.6)]"
                        style={{
                          left: `${marker.left}%`,
                          top: `${marker.top}%`,
                        }}
                      />
                    )}
                  </>
                ) : (
                  <div className="screenshot-empty">
                    <Monitor size={28} />
                    <span>Screenshot unavailable</span>
                    <small>
                      The saved action and verifier evidence remain available
                      below.
                    </small>
                    {src && (
                      <button
                        className="text-link"
                        onClick={() => setFailedImage("")}
                      >
                        Retry image
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div
                className="my-3 flex flex-wrap items-center gap-2"
                role="group"
                aria-label="Evidence playback"
                onKeyDown={(event) => {
                  if ((event.target as HTMLElement).tagName === "SELECT")
                    return;
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    selectFrame(index + (event.key === "ArrowLeft" ? -1 : 1));
                  }
                }}
              >
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Previous frame"
                  disabled={index <= 0 || !frames.length}
                  onClick={() => selectFrame(index - 1)}
                >
                  <ChevronLeft size={16} />
                </Button>
                <Button
                  variant="outline"
                  disabled={frames.length < 2}
                  onClick={() => {
                    if (!playing && index >= frames.length - 1) setIndex(0);
                    setPlaying(!playing);
                  }}
                >
                  {playing ? <Pause size={15} /> : <Play size={15} />}
                  {playing ? "Pause" : "Play"}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Next frame"
                  disabled={index >= frames.length - 1 || !frames.length}
                  onClick={() => selectFrame(index + 1)}
                >
                  <ChevronRight size={16} />
                </Button>
                <span className="text-xs muted">
                  {frames.length
                    ? `${index + 1} / ${frames.length}`
                    : "No saved frames"}
                </span>
                <select
                  aria-label="Playback interval"
                  className="ml-auto rounded border border-white/15 bg-[#17251d] p-2 text-xs"
                  value={intervalMs}
                  onChange={(event) =>
                    setIntervalMs(Number(event.target.value))
                  }
                >
                  <option value={750}>0.75s / frame</option>
                  <option value={1500}>1.5s / frame</option>
                  <option value={3000}>3s / frame</option>
                </select>
              </div>
              <p className="muted text-xs leading-relaxed">
                Playback uses a fixed interval. Action screenshots show the
                state before execution; markers show requested clicks, not
                confirmation that they succeeded.
              </p>
              {!!frames.length && (
                <select
                  aria-label="Select evidence frame"
                  className="mt-3 w-full rounded border border-white/15 bg-[#17251d] p-2 text-sm"
                  value={index}
                  onChange={(event) => selectFrame(Number(event.target.value))}
                >
                  {frames.map((item, position) => (
                    <option value={position} key={item.id}>
                      {item.label}
                      {item.action ? ` · ${prettyName(item.action.kind)}` : ""}
                      {!item.available ? " · image missing" : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="trajectory">
              <h4>
                {frame?.label || "Action history"}{" "}
                <span>
                  {frame?.action
                    ? prettyName(frame.action.kind)
                    : "No associated action"}
                </span>
              </h4>
              {frame?.events.length ? (
                frame.events.map((event, eventIndex) => (
                  <div key={`${frame.id}-${eventIndex}`}>
                    {event.action_error && (
                      <Notice error>{event.action_error}</Notice>
                    )}
                    {event.action && (
                      <pre className="json-block">
                        {JSON.stringify(event.action, null, 2)}
                      </pre>
                    )}
                    {event.response !== undefined && (
                      <details className="action-frame">
                        <summary>
                          Model response <ChevronDown size={14} />
                        </summary>
                        <pre>{JSON.stringify(event.response, null, 2)}</pre>
                      </details>
                    )}
                    <details className="action-frame">
                      <summary>
                        Saved event <ChevronDown size={14} />
                      </summary>
                      <pre>{JSON.stringify(event, null, 2)}</pre>
                    </details>
                  </div>
                ))
              ) : (
                <p className="muted">
                  {frame?.screenshot === "final.jpg"
                    ? "State captured after verification. No model action is associated with this image."
                    : "No action was saved for this frame. An image alone does not establish what the agent did."}
                </p>
              )}
            </div>
          </div>
          {detail.warnings.map((warning, warningIndex) => (
            <Notice key={`${warningIndex}-${warning}`}>{warning}</Notice>
          ))}
        </>
      )}
      <details className="evidence-json">
        <summary>
          <FileCode2 size={16} />
          Verifier evidence
          <ChevronDown size={14} />
        </summary>
        <pre className="json-block">
          {JSON.stringify(trial.evidence, null, 2)}
        </pre>
      </details>
      <details className="evidence-json">
        <summary>
          <Terminal size={16} />
          Task instructions
          <ChevronDown size={14} />
        </summary>
        <p>
          {run.tasks[trial.task_id]?.definition.prompt ||
            "Saved task instructions are unavailable in this older run."}
        </p>
      </details>
      <ReviewPanel endpoint={`${endpoint}/review`} />
    </section>
  );
}

type Review = ReviewDraft & {
  revision: number;
  evidenceDigest: string;
  currentEvidenceDigest: string;
  updatedAt: string | null;
  stale: boolean;
  history: Array<ReviewDraft & { revision: number; updatedAt: string }>;
};
const emptyReview: ReviewDraft = {
  verdict: "unreviewed",
  category: "uncertain",
  note: "",
  reviewer: "",
};
function draftOf(review: Review): ReviewDraft {
  return {
    verdict: review.verdict,
    category: review.category,
    note: review.note,
    reviewer: review.reviewer,
  };
}

function ReviewPanel({ endpoint }: { endpoint: string }) {
  const [retained] = useState(() => reviewDrafts.get(endpoint));
  const [review, setReview] = useState<Review | null>(null);
  const [draft, setDraft] = useState<ReviewDraft>(
    retained?.draft ?? emptyReview,
  );
  const [base, setBase] = useState<DraftBase | null>(retained?.base ?? null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checkedEvidence, setCheckedEvidence] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setMessage("");
    request<Review>(endpoint, { signal: controller.signal })
      .then((saved) => {
        if (!controller.signal.aborted) {
          setReview(saved);
          if (reload === 0 && retained) {
            setMessage("Restored unsaved notes from this session.");
            if (
              retained.base.revision !== saved.revision ||
              retained.base.evidenceDigest !== saved.currentEvidenceDigest
            ) {
              setError(
                "The saved review or evidence changed while this draft was closed. Your original revision is preserved. Copy your notes before discarding and reloading the latest review.",
              );
            }
          } else {
            setDraft(draftOf(saved));
            setBase({
              revision: saved.revision,
              evidenceDigest: saved.currentEvidenceDigest,
            });
            reviewDrafts.remove(endpoint);
          }
          setCheckedEvidence(false);
        }
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, reload, retained]);
  const dirty =
    JSON.stringify(draft) !==
    JSON.stringify(review ? draftOf(review) : emptyReview);
  useEffect(() => {
    if (!review || !base || loading) return;
    if (dirty) reviewDrafts.set(endpoint, { draft, base });
    else reviewDrafts.remove(endpoint);
  }, [endpoint, review, base, draft, dirty, loading]);
  const change = (next: Partial<ReviewDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setMessage("");
  };
  const save = async () => {
    if (!review || !base || saving || (review.stale && !checkedEvidence))
      return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const saved = await request<Review>(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          revision: base.revision,
          evidenceDigest: base.evidenceDigest,
        }),
      });
      reviewDrafts.remove(endpoint, { draft, base });
      if (mounted.current) {
        setReview(saved);
        setDraft(draftOf(saved));
        setBase({
          revision: saved.revision,
          evidenceDigest: saved.currentEvidenceDigest,
        });
        setCheckedEvidence(false);
        setMessage(`Saved revision ${saved.revision}.`);
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          `${cause instanceof Error ? cause.message : "Review could not be saved."} Your text is preserved in this session. Copy it before reloading the page or discarding the draft.`,
        );
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  return (
    <section
      className="mt-6 rounded-xl border border-white/10 bg-white/[0.02] p-4"
      aria-label="Human review"
    >
      <div className="section-heading">
        <h3>Human review</h3>
        <Badge variant="outline">
          {review ? `Revision ${review.revision}` : "Local notes"}
        </Badge>
      </div>
      <p className="muted mb-4 text-xs leading-relaxed">
        Notes are saved separately from experiment evidence. Review decisions
        never change the verifier result or regression scores. Unsaved drafts
        survive navigation for the 32 most recently edited trials in this page
        session. Reloading the page clears them.
      </p>
      {review?.stale && (
        <Notice>
          The evidence files have changed since this review. Reopen this trial
          to inspect the current evidence before attaching a new review
          revision.
        </Notice>
      )}
      {error && <Notice error>{error}</Notice>}
      <fieldset
        disabled={loading || saving}
        className="space-y-3 disabled:opacity-60"
      >
        {review?.stale && (
          <label className="flex items-start gap-2 text-xs leading-relaxed">
            <input
              type="checkbox"
              checked={checkedEvidence}
              onChange={(event) => setCheckedEvidence(event.target.checked)}
              className="mt-0.5"
            />
            I checked the current evidence and want this revision to refer to
            it.
          </label>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-2 text-xs">
            Review decision
            <select
              value={draft.verdict}
              onChange={(event) =>
                change({
                  verdict: event.target.value as ReviewDraft["verdict"],
                })
              }
              className="rounded border border-white/15 bg-[#17251d] p-2"
            >
              <option value="unreviewed">Unreviewed</option>
              <option value="confirmed">Verifier result confirmed</option>
              <option value="needs-investigation">Needs investigation</option>
              <option value="verifier-issue">Possible verifier issue</option>
            </select>
          </label>
          <label className="grid gap-2 text-xs">
            Likely cause
            <select
              value={draft.category}
              onChange={(event) =>
                change({
                  category: event.target.value as ReviewDraft["category"],
                })
              }
              className="rounded border border-white/15 bg-[#17251d] p-2"
            >
              {["uncertain", "agent", "environment", "task", "verifier"].map(
                (category) => (
                  <option value={category} key={category}>
                    {prettyName(category)}
                  </option>
                ),
              )}
            </select>
          </label>
        </div>
        <label className="grid gap-2 text-xs">
          Reviewer (optional)
          <Input
            value={draft.reviewer}
            maxLength={120}
            onChange={(event) => change({ reviewer: event.target.value })}
            placeholder="Name or initials"
          />
        </label>
        <label className="grid gap-2 text-xs">
          Investigation notes
          <textarea
            value={draft.note}
            maxLength={8000}
            rows={5}
            onChange={(event) => change({ note: event.target.value })}
            placeholder="What happened, evidence to inspect, and the next experiment…"
            className="w-full resize-y rounded-md border border-white/15 bg-[#101c15] p-3 text-sm leading-relaxed focus-visible:outline-2 focus-visible:outline-emerald-500"
          />
          <span className="muted">
            {draft.note.length.toLocaleString()} / 8,000 characters ·{" "}
            {dirty
              ? "Unsaved changes — save before leaving this trial"
              : "No unsaved changes"}
          </span>
        </label>
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          onClick={save}
          disabled={
            !review ||
            loading ||
            saving ||
            (review.stale && !checkedEvidence) ||
            (!dirty && !review.stale)
          }
        >
          {saving ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Save size={15} />
          )}
          {saving ? "Saving…" : "Save review"}
        </Button>
        <Button
          variant="ghost"
          disabled={saving || loading}
          onClick={() => setReload((value) => value + 1)}
        >
          {dirty ? "Discard edits and reload" : "Reload review"}
        </Button>
        {loading && <span className="muted text-xs">Loading review…</span>}
        <span role="status" className="accent text-xs">
          {message}
        </span>
      </div>
      {review && review.history.length > 0 && (
        <details className="evidence-json mt-4">
          <summary>
            Review history · {review.history.length} saved revisions
            <ChevronDown size={14} />
          </summary>
          <div className="max-h-72 space-y-3 overflow-auto p-3">
            {[...review.history].reverse().map((revision) => (
              <article
                className="rounded border border-white/10 p-3 text-xs"
                key={revision.revision}
              >
                <p className="mb-2">
                  Revision {revision.revision} · {prettyName(revision.verdict)}{" "}
                  · {revision.reviewer || "Unnamed reviewer"}
                </p>
                <p className="muted mb-2">{revision.updatedAt}</p>
                <p className="whitespace-pre-wrap break-words">
                  {revision.note || "No note."}
                </p>
              </article>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
