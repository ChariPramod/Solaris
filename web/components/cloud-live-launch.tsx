"use client";
import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  FlaskConical,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Button } from "./ui/button";
import { api } from "@/lib/client";
import {
  liveCheckAllowsLaunch,
  setupIdentity,
  type LaunchCheck,
} from "@/lib/launch-readiness";
import type { Readiness, RunSetup } from "@/lib/types";

export function CloudLiveLaunch({
  setup,
  busy,
  onLaunch,
}: {
  setup: RunSetup;
  busy: boolean;
  onLaunch: () => void;
}) {
  const [check, setCheck] = useState<LaunchCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const request = useRef<AbortController | null>(null);
  const identity = setupIdentity(setup);
  useEffect(() => {
    request.current?.abort();
    setCheck(null);
    setError("");
    setChecking(false);
    return () => request.current?.abort();
  }, [identity]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const current = check?.setup === identity ? check : null;
  const ready = liveCheckAllowsLaunch(current, setup, now);
  return (
    <section
      className="my-4 rounded-xl border bg-background p-4"
      aria-label="Live launch readiness"
    >
      <h3 className="text-sm font-semibold">Check setup before starting</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Checks server configuration and storage for this evaluation. Credentials
        are authenticated by the providers only when a live run starts.
      </p>
      <Button
        className="mt-3"
        variant="outline"
        disabled={busy || checking || !setup.tasks.length}
        onClick={async () => {
          request.current?.abort();
          const abort = new AbortController();
          request.current = abort;
          setChecking(true);
          setCheck(null);
          setError("");
          try {
            const result = await api<Readiness>("/api/preflight", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(setup),
              signal: abort.signal,
            });
            if (!abort.signal.aborted) {
              const checkedAt = Date.now();
              setNow(checkedAt);
              setCheck({ setup: identity, checkedAt, result });
            }
          } catch (e) {
            if (!abort.signal.aborted) setError((e as Error).message);
          } finally {
            if (!abort.signal.aborted) setChecking(false);
          }
        }}
      >
        {checking ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
        {checking ? "Checking setup…" : "Check live setup"}
      </Button>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error} You can inspect saved evidence while setup is unavailable.
        </p>
      )}
      {current && (
        <div className="mt-4 space-y-3" aria-live="polite">
          {current.result.checks.map((item, index) => (
            <div
              key={`${item.name}-${index}`}
              className="flex items-start gap-2 text-sm"
            >
              {item.status === "pass" ? (
                <CheckCircle2
                  size={16}
                  className="mt-0.5 shrink-0 text-primary"
                />
              ) : (
                <CircleAlert
                  size={16}
                  className="mt-0.5 shrink-0 text-destructive"
                />
              )}
              <p>
                <strong>{item.name}</strong>
                <span className="mt-1 block text-muted-foreground">
                  {item.message}
                </span>
              </p>
            </div>
          ))}
          {!ready && (
            <p className="text-sm text-muted-foreground">
              {current.result.ready
                ? "This check has expired. Check setup again before launching."
                : "Resolve the checks above, redeploy after changing server settings, then check again. Diagnostics remain available without provider keys."}
            </p>
          )}
        </div>
      )}
      <Button
        className="primary-button mt-4 w-full"
        disabled={busy || checking || !ready}
        onClick={() => {
          if (liveCheckAllowsLaunch(current, setup)) onLaunch();
          else {
            setCheck(null);
            setError("Check setup again before launching.");
          }
        }}
      >
        {busy ? <Loader2 className="animate-spin" /> : <FlaskConical />}
        {busy ? "Starting worker…" : "Start live evaluation"}
      </Button>
    </section>
  );
}
