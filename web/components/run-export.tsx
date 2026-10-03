"use client";
import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "./ui/button";

/** A failed/aborted response never produces a deceptively complete download. */
export function RunExport({ runId }: { runId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    pending.current?.abort();
    setBusy(false);
    setError("");
    setDone(false);
    return () => pending.current?.abort();
  }, [runId]);
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        disabled={busy}
        onClick={async () => {
          const abort = new AbortController();
          pending.current = abort;
          setBusy(true);
          setError("");
          setDone(false);
          try {
            const response = await fetch(
              `/api/runs/${encodeURIComponent(runId)}/bundle`,
              { cache: "no-store", signal: abort.signal },
            );
            if (!response.ok) {
              const payload = await response.json().catch(() => null);
              throw new Error(
                typeof payload?.error === "string"
                  ? payload.error
                  : "Evidence export is unavailable. Please retry.",
              );
            }
            if (response.headers.get("content-type") !== "application/gzip")
              throw new Error(
                "The server returned an unexpected export. Please retry.",
              );
            const blob = await response.blob();
            if (abort.signal.aborted) return;
            if (!blob.size || blob.size > 80 * 1024 * 1024)
              throw new Error(
                "Evidence export size is invalid. No file was downloaded.",
              );
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `${runId}-evidence.tar.gz`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setDone(true);
          } catch (error) {
            if (!abort.signal.aborted)
              setError(
                error instanceof Error
                  ? error.message
                  : "Evidence download failed. Please retry.",
              );
          } finally {
            if (!abort.signal.aborted) setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Download />}
        {busy ? "Preparing evidence…" : "Download evidence bundle"}
      </Button>
      {busy && (
        <p className="max-w-sm text-xs text-muted-foreground" role="status">
          Verifying saved artifacts and reviews before downloading.
        </p>
      )}
      {done && (
        <p className="max-w-sm text-xs text-muted-foreground" role="status">
          Bundle downloaded with handoff summary, evidence, review histories and
          checksums. Inspect before sharing.
        </p>
      )}
      {error && (
        <p className="max-w-sm text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
