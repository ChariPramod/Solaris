"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Download, FileCheck2, Loader2 } from "lucide-react";
import { Button } from "./ui/button";

export function ProjectHandoff({
  projectId,
  revision,
  disabled = false,
}: {
  projectId: string;
  revision: number;
  disabled?: boolean;
}) {
  const labelId = useId();
  const [format, setFormat] = useState<"markdown" | "json">("markdown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setError("");
    setMessage("");
    return () => pending.current?.abort();
  }, [projectId, revision]);

  async function download() {
    if (disabled || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const query = new URLSearchParams({ revision: String(revision), format });
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/handoff?${query}`,
        {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(110000),
          ]),
        },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Project handoff is unavailable. Please retry.",
        );
      }
      const unavailable =
        response.headers.get("x-solaris-unavailable-runs") ?? "";
      if (
        !response.headers
          .get("content-type")
          ?.startsWith(
            format === "json" ? "application/json" : "text/markdown",
          ) ||
        response.headers.get("x-solaris-project-revision") !==
          String(revision) ||
        !/^\d{1,3}$/.test(unavailable) ||
        Number(unavailable) > 200
      )
        throw new Error(
          "The server returned an unexpected handoff. No file was downloaded.",
        );
      const blob = await response.blob();
      if (controller.signal.aborted || pending.current !== controller) return;
      if (!blob.size || blob.size > 2 * 1024 * 1024)
        throw new Error("The handoff size is invalid. No file was downloaded.");
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `${projectId}-r${revision}-handoff.${format === "json" ? "json" : "md"}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setMessage(
        Number(unavailable) > 0
          ? `Handoff prepared with ${unavailable} unavailable evaluation${Number(unavailable) === 1 ? "" : "s"}, clearly listed in the download. No result was inferred. Inspect before sharing.`
          : "Handoff prepared from saved manifests. Private notes are excluded. Inspect before sharing.",
      );
    } catch (reason) {
      if (!controller.signal.aborted && pending.current === controller)
        setError(
          reason instanceof Error
            ? reason.message
            : "Project handoff failed. Please retry.",
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <section
      className="mt-5 space-y-3 rounded-lg border bg-muted/20 p-4"
      aria-label="Project handoff download"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <FileCheck2 aria-hidden="true" className="size-4 text-primary" />
        Client handoff
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Export saved revision {revision} and summaries of every assigned
        evaluation, including those outside the loaded library. Private notes
        and unsaved changes are excluded. Evidence files are downloaded
        separately.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs" htmlFor={labelId}>
          <span className="block text-muted-foreground">Download format</span>
          <select
            id={labelId}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            value={format}
            disabled={busy || disabled}
            onChange={(event) =>
              setFormat(event.target.value as "markdown" | "json")
            }
          >
            <option value="markdown">Readable Markdown</option>
            <option value="json">Structured JSON</option>
          </select>
        </label>
        <Button
          type="button"
          variant="outline"
          disabled={busy || disabled}
          onClick={() => void download()}
        >
          {busy ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <Download aria-hidden="true" />
          )}
          {busy ? "Checking manifests…" : "Download project handoff"}
        </Button>
      </div>
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Checking each saved manifest and project revision. No evidence is
          changed.
        </p>
      )}
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
