"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import type { AttemptLink } from "@/lib/workspace-data";
export function AttemptHistory({
  id,
  onOpen,
}: {
  id: string;
  onOpen: (id: string) => void;
}) {
  const [links, setLinks] = useState<{
    parents: AttemptLink[];
    children: AttemptLink[];
  } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setError("");
    setLinks(null);
    api<{ parents: AttemptLink[]; children: AttemptLink[] }>(
      `/api/runs/${encodeURIComponent(id)}/attempts`,
      { signal: c.signal },
    )
      .then(setLinks)
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [id, retry]);
  return (
    <section className="space-y-3 py-4">
      <h3 className="font-semibold">Linked attempts</h3>
      <p className="text-sm text-muted-foreground">
        Each rerun is a new experiment. Original outcomes remain in the earlier
        run; links do not establish comparison compatibility.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}{" "}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRetry((v) => v + 1)}
          >
            Retry
          </Button>
        </p>
      )}
      {links && (
        <>
          {links.parents.length + links.children.length === 0 && (
            <p className="text-sm">No linked attempts recorded.</p>
          )}
          {[
            ...links.parents.map((v) => ({
              label: "Earlier attempt",
              id: v.parentId,
              time: v.createdAt,
            })),
            ...links.children.map((v) => ({
              label: "Later attempt",
              id: v.childId,
              time: v.createdAt,
            })),
          ].map((v) => (
            <div
              key={v.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"
            >
              <span>{v.label}</span>
              <Button
                className="max-w-full truncate"
                variant="link"
                onClick={() => onOpen(v.id)}
              >
                {v.id}
              </Button>
              <span className="text-xs text-muted-foreground">
                {new Date(v.time).toLocaleString()}
              </span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
