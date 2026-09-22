"use client";
import { useEffect, useState } from "react";
import { BookmarkPlus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/client";
import type { RunSetup } from "@/lib/types";
import type { Preset } from "@/lib/workspace-data";
export function SavedSetups({
  setup,
  onLoad,
  disabled,
}: {
  setup: RunSetup;
  onLoad: (v: RunSetup) => void;
  disabled: boolean;
}) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    api<Preset[]>("/api/presets", { signal: c.signal })
      .then((values) => {
        if (!c.signal.aborted) setPresets(values);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, []);
  const current = presets.find((p) => p.id === selected);
  async function save(copy: boolean) {
    if (loading || busy || disabled) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const value = await api<Preset>("/api/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(current && !copy ? { id: current.id } : {}),
          revision: current && !copy ? current.revision : 0,
          name,
          setup,
        }),
      });
      setPresets((p) => [value, ...p.filter((v) => v.id !== value.id)]);
      setSelected(value.id);
      setMessage(`Saved revision ${value.revision}.`);
    } catch (e) {
      setError(
        (e as Error).message + " Your current setup is still available.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="my-4 rounded-xl border bg-muted/20 p-4">
      {loading && (
        <p role="status" className="mb-2 text-xs">
          Loading saved configurations…
        </p>
      )}
      <fieldset disabled={disabled || busy || loading} className="space-y-3">
        <label className="block space-y-2 text-sm">
          Saved configurations
          <select
            value={selected}
            className="w-full rounded-lg border bg-background p-2"
            onChange={(e) => {
              setSelected(e.target.value);
              const p = presets.find((p) => p.id === e.target.value);
              setName(p?.name || "");
              setMessage("");
            }}
          >
            <option value="">New configuration</option>
            {presets.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name} · revision {p.revision}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!current}
            onClick={() => {
              if (current) {
                onLoad(current.setup);
                setMessage("Loaded saved configuration.");
              }
            }}
          >
            Load selection
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Refresh saved configurations"
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                setPresets(await api<Preset[]>("/api/presets"));
                setSelected("");
                setMessage(
                  "List refreshed. Select and load a configuration to replace the form.",
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={14} />
          </Button>
        </div>
        <label className="block space-y-2 text-sm">
          Configuration name
          <Input
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Browser smoke test"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!name.trim() || !setup.tasks.length}
            onClick={() => void save(false)}
          >
            <BookmarkPlus size={14} />
            {current ? "Save new revision" : "Save configuration"}
          </Button>
          {current && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!name.trim() || !setup.tasks.length}
              onClick={() => void save(true)}
            >
              Save as a copy
            </Button>
          )}
        </div>
      </fieldset>
      {current && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer">
            Revision history ({current.history.length})
          </summary>
          <div className="mt-2 space-y-2">
            {current.history
              .slice()
              .reverse()
              .map((h) => (
                <div
                  key={h.revision}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span>
                    Revision {h.revision} · {h.name} ·{" "}
                    {new Date(h.updatedAt).toLocaleString()}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || busy || loading}
                    onClick={() => {
                      onLoad(h.setup);
                      setMessage(
                        `Loaded revision ${h.revision}. Saving creates a new revision.`,
                      );
                    }}
                  >
                    Load
                  </Button>
                </div>
              ))}
          </div>
        </details>
      )}
      {message && (
        <p role="status" className="mt-2 text-xs">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
