"use client";

import { useEffect, useState } from "react";
import { Layers3, Loader2, LockKeyhole, LogOut } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { api } from "@/lib/client";

/** Session cookies are server-owned; the access key is never persisted in browser storage. */
export function CloudAccess({
  children,
  cloud = true,
}: {
  children: React.ReactNode;
  cloud?: boolean;
}) {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(cloud);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!cloud) return;
    const abort = new AbortController();
    api<{ authenticated: boolean }>("/api/session", { signal: abort.signal })
      .then((session) => {
        setAuthenticated(session.authenticated);
        setError("");
      })
      .catch((e: Error) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setChecking(false);
      });
    return () => abort.abort();
  }, [cloud]);
  if (!cloud) return children;
  if (authenticated)
    return (
      <>
        {children}
        <div className="fixed right-4 bottom-4 z-50 flex max-w-sm flex-col items-end gap-2">
          {error && (
            <p
              role="alert"
              className="rounded-lg border bg-background p-3 text-sm"
            >
              {error}
            </p>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await api("/api/session", {
                  method: "DELETE",
                  headers: { "Content-Type": "application/json" },
                  body: "{}",
                });
                setAuthenticated(false);
                setKey("");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <LogOut size={14} />
            Sign out
          </Button>
        </div>
      </>
    );
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <section className="w-full max-w-md rounded-2xl border bg-card p-8 shadow-sm">
        <Layers3 className="mb-6 text-primary" size={32} />
        <p className="eyebrow">SOLARIS WORKSPACE</p>
        <h1 className="mt-2 text-2xl font-semibold">
          Your evaluation workspace
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Run evaluations, inspect saved evidence, and track regressions. Sign
          in with your workspace access key.
        </p>
        {checking ? (
          <p role="status" className="mt-6 flex items-center gap-2 text-sm">
            <Loader2 className="animate-spin" size={16} />
            Checking session…
          </p>
        ) : (
          <form
            className="mt-6 space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy || !key.trim()) return;
              setBusy(true);
              setError("");
              try {
                const session = await api<{ authenticated: boolean }>(
                  "/api/session",
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ key }),
                  },
                );
                if (!session.authenticated)
                  throw new Error("Sign-in was not confirmed. Try again.");
                setKey("");
                setAuthenticated(true);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="block space-y-2 text-sm font-medium">
              Access key
              <Input
                type="password"
                name="access-key"
                autoComplete="current-password"
                required
                maxLength={512}
                disabled={busy}
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
            </label>
            <Button
              type="submit"
              className="w-full"
              disabled={busy || !key.trim()}
            >
              {busy ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <LockKeyhole size={16} />
              )}
              Sign in
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
