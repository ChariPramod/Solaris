"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  FileSearch,
  GitCompareArrows,
  Code2,
  Layers3,
  Loader2,
  LockKeyhole,
  LogOut,
  Play,
  ShieldCheck,
} from "lucide-react";
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
  useEffect(() => {
    if (cloud) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [authenticated, cloud]);
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
    <div className="min-h-screen bg-background">
      <a
        href="#product-overview"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:bg-card focus:p-3"
      >
        Skip to product overview
      </a>
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-7 sm:px-10">
        <a
          href="/"
          aria-label="Solaris home"
          className="flex items-center gap-3 font-semibold tracking-tight"
        >
          <span className="rounded-xl border border-primary/25 bg-primary/10 p-2 text-primary">
            <Layers3 size={22} aria-hidden="true" />
          </span>
          <span className="text-xl">
            Solaris
            <span className="ml-2 hidden text-xs font-normal tracking-normal text-muted-foreground sm:inline">
              AGENT EVALUATIONS
            </span>
          </span>
        </a>
        <a
          href="https://github.com/ChariPramod/Solaris"
          className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <Code2 size={17} aria-hidden="true" />
          Public source
          <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </header>
      <main
        id="product-overview"
        className="mx-auto w-full max-w-6xl px-6 pb-12 sm:px-10"
      >
        <div className="grid items-start gap-10 pt-8 pb-12 lg:grid-cols-[1.35fr_1fr] lg:gap-16 lg:pt-16 lg:pb-16">
          <section aria-labelledby="product-title">
            <p className="mb-5 flex items-center gap-2 text-xs font-medium tracking-[0.12em] text-primary">
              <span
                className="size-1.5 rounded-full bg-primary"
                aria-hidden="true"
              />
              EVIDENCE OVER ASSUMPTIONS
            </p>
            <h1
              id="product-title"
              className="max-w-2xl text-4xl leading-[1.12] font-semibold tracking-[-0.04em] sm:text-5xl"
            >
              Know what your agent
              <br className="hidden sm:block" /> can actually do.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
              Solaris tests computer-use agents on real desktop tasks, checks
              the resulting files and app state, and keeps the evidence behind
              every outcome.
            </p>
            <div className="mt-7 flex flex-wrap gap-x-6 gap-y-3 text-sm">
              <a
                href="#evaluation-workflow"
                className="inline-flex items-center gap-2 text-primary"
              >
                Explore the workflow
                <ArrowRight size={16} aria-hidden="true" />
              </a>
              <a
                href="https://github.com/ChariPramod/Solaris#readme"
                className="inline-flex items-center gap-2 text-muted-foreground"
              >
                Read the documentation
                <ArrowUpRight size={15} aria-hidden="true" />
              </a>
            </div>
            <dl className="mt-9 grid grid-cols-2 gap-6 border-t pt-6">
              <div>
                <dt className="text-sm font-semibold">12 built-in tasks</dt>
                <dd className="mt-1.5 text-sm leading-6 text-muted-foreground">
                  Browser, files, forms, spreadsheets and PDFs.
                </dd>
              </div>
              <div>
                <dt className="text-sm font-semibold">Two model adapters</dt>
                <dd className="mt-1.5 text-sm leading-6 text-muted-foreground">
                  Claude computer use and OpenAI vision actions.
                </dd>
              </div>
            </dl>
          </section>
          <section
            aria-labelledby="workspace-signin-title"
            className="rounded-2xl border bg-card p-6 shadow-xl shadow-black/10 sm:p-8"
          >
            <div className="mb-5 flex items-center justify-between gap-3">
              <span className="rounded-lg border p-2 text-primary">
                <LockKeyhole size={20} aria-hidden="true" />
              </span>
              <span className="rounded-full border px-3 py-1 text-xs text-muted-foreground">
                Private workspace
              </span>
            </div>
            <h2
              id="workspace-signin-title"
              className="text-xl font-semibold tracking-tight"
            >
              Open your evaluation workspace
            </h2>
            <p
              id="access-help"
              className="mt-3 text-sm leading-6 text-muted-foreground"
            >
              Use the owner access key to launch runs, inspect saved evidence,
              and review changes. Source code is public; run data stays private.
            </p>
            {checking ? (
              <p
                role="status"
                className="mt-6 flex min-h-32 items-center gap-2 text-sm text-muted-foreground"
              >
                <Loader2 className="animate-spin" size={16} />
                Checking session…
              </p>
            ) : (
              <form
                className="mt-6 space-y-5"
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
                    id="workspace-access-key"
                    name="access-key"
                    aria-describedby="access-help"
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
                  className="w-full min-h-11"
                  disabled={busy || !key.trim()}
                >
                  {busy ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <LockKeyhole size={16} />
                  )}
                  {busy ? "Signing in…" : "Open workspace"}
                </Button>
              </form>
            )}
            {error && (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {error}
              </p>
            )}
            <p className="mt-6 border-t pt-4 text-xs leading-5 text-muted-foreground">
              Self-hosting? Follow the{" "}
              <a
                className="underline underline-offset-4 hover:text-foreground"
                href="https://github.com/ChariPramod/Solaris/blob/main/docs/VERCEL.md"
              >
                deployment guide
              </a>{" "}
              to configure your own workspace.
            </p>
          </section>
        </div>
        <section
          id="evaluation-workflow"
          aria-labelledby="workflow-title"
          className="border-t pt-9"
        >
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground">
                THE EVALUATION LOOP
              </p>
              <h2
                id="workflow-title"
                className="mt-2 text-2xl font-semibold tracking-tight"
              >
                From a task to a decision.
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Every new attempt keeps its own history.
            </p>
          </div>
          <ol className="grid gap-4 md:grid-cols-3">
            {[
              {
                icon: Play,
                number: "01",
                title: "Run a repeatable task",
                detail:
                  "Choose tasks, a provider and repeat counts. Save the setup and run the Python harness in an isolated cloud worker.",
              },
              {
                icon: FileSearch,
                number: "02",
                title: "Inspect what happened",
                detail:
                  "Follow screenshots and actions. Read verifier evidence, investigate failures, and add review notes without changing the score.",
              },
              {
                icon: GitCompareArrows,
                number: "03",
                title: "Check what changed",
                detail:
                  "Compare compatible runs and apply regression gates. Missing trials, cleanup problems and unknown costs stay visible.",
              },
            ].map((step) => (
              <li
                key={step.number}
                className="rounded-xl border bg-card/60 p-5 sm:p-6"
              >
                <div className="mb-5 flex items-center justify-between">
                  <step.icon
                    size={21}
                    className="text-primary"
                    aria-hidden="true"
                  />
                  <span className="font-mono text-xs text-muted-foreground">
                    {step.number}
                  </span>
                </div>
                <h3 className="font-semibold">{step.title}</h3>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  {step.detail}
                </p>
              </li>
            ))}
          </ol>
        </section>
        <section
          aria-labelledby="validation-title"
          className="mt-6 flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-5"
        >
          <ShieldCheck
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div>
            <h2 id="validation-title" className="text-sm font-semibold">
              Working cloud diagnostics. Live benchmarks still to validate.
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Cloud execution, saved evidence, reviews, comparisons and gates
              have passed production checks using dry runs. Dry runs test the
              harness with a static agent; they do not measure model
              performance. There are no verified live benchmark results yet.
            </p>
          </div>
        </section>
        <footer className="mt-9 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>Solaris · Powered by the Gauntlet evaluation harness</p>
          <a
            href="https://github.com/ChariPramod/Solaris"
            className="inline-flex items-center gap-1.5 hover:text-foreground"
          >
            Inspect the source
            <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        </footer>
      </main>
    </div>
  );
}
