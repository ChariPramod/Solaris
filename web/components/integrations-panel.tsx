"use client";
import { useEffect, useState } from "react";
import {
  Cable,
  Check,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Workflow,
  ExternalLink,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { api } from "@/lib/client";
import type {
  IntegrationScope,
  IntegrationToken,
} from "@/lib/integration-tokens";
import {
  AUTOMATION_ENDPOINTS,
  AUTOMATION_SAMPLE,
  INTEGRATION_RECIPES,
} from "@/lib/integration-recipes";
const permissions: [IntegrationScope, string][] = [
  ["read", "Read saved runs and job status"],
  ["execute", "Start cloud diagnostics"],
  ["live:execute", "Start live evaluations (provider usage)"],
  ["assess", "Run comparisons and quality gates"],
];
export function IntegrationsPanel({ cloud }: { cloud: boolean }) {
  const [tokens, setTokens] = useState<IntegrationToken[]>([]),
    [loaded, setLoaded] = useState(false),
    [fetching, setFetching] = useState(cloud),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [name, setName] = useState(""),
    [days, setDays] = useState("30"),
    [scopes, setScopes] = useState<IntegrationScope[]>(["read"]),
    [secret, setSecret] = useState(""),
    [copied, setCopied] = useState(false),
    [confirm, setConfirm] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!cloud) return;
    const abort = new AbortController();
    setFetching(true);
    api<{ tokens: IntegrationToken[] }>("/api/integrations/tokens", {
      signal: abort.signal,
    })
      .then((data) => {
        setTokens(data.tokens);
        setLoaded(true);
        setError("");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setFetching(false);
      });
    return () => abort.abort();
  }, [cloud, refresh]);
  async function create() {
    if (!loaded || fetching || busy) return;
    setBusy(true);
    setError("");
    setSecret("");
    setCopied(false);
    try {
      const result = await api<{ token: IntegrationToken; secret: string }>(
        "/api/integrations/tokens",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, scopes, expiresInDays: Number(days) }),
        },
      );
      setSecret(result.secret);
      setTokens((previous) => [result.token, ...previous]);
      setName("");
    } catch (e) {
      setError(
        (e as Error).message +
          " Refresh the key list before retrying if the response was lost.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    if (!loaded || fetching || busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/integrations/tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setConfirm(null);
      setFetching(true);
      setRefresh((v) => v + 1);
      setSecret("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function toggle(scope: IntegrationScope, checked: boolean) {
    setScopes((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(scope);
        if (scope === "live:execute") next.add("execute");
      } else {
        next.delete(scope);
        if (scope === "execute") next.delete("live:execute");
      }
      return [...next];
    });
  }
  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-6">
        <div className="flex items-center gap-2">
          <Cable className="text-primary" size={22} />
          <h2 className="text-xl font-semibold">
            Connect your delivery workflow
          </h2>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Trigger real evaluations from the tools your agency already uses.
          Every request produces the same durable job, evidence and quality
          checks as the workspace.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge variant="outline">Scoped API keys</Badge>
          <Badge variant="outline">Duplicate-request protection</Badge>
          <Badge variant="outline">Revocable access</Badge>
        </div>
      </section>
      <div className="grid gap-4 lg:grid-cols-3">
        {INTEGRATION_RECIPES.map((recipe) => (
          <article key={recipe.id} className="rounded-xl border bg-card p-5">
            <Workflow size={22} className="mb-3 text-primary" />
            <h3 className="text-lg font-semibold">{recipe.name}</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {recipe.description}
            </p>
            <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm">
              {recipe.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <a
              className="mt-4 inline-flex items-center gap-1 text-sm underline"
              href={recipe.documentation}
              target="_blank"
              rel="noreferrer"
            >
              Provider setup guide
              <ExternalLink size={13} />
            </a>
          </article>
        ))}
      </div>
      {!cloud ? (
        <p className="rounded-xl border p-5 text-sm">
          API credentials are managed in the authenticated cloud workspace.
          Local evaluations and exports remain available.
        </p>
      ) : (
        <section
          className="rounded-xl border bg-card p-6"
          aria-label="Integration credentials"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <KeyRound size={20} />
              API credentials
            </h2>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || fetching}
              onClick={() => {
                setFetching(true);
                setRefresh((v) => v + 1);
              }}
            >
              <RefreshCw size={15} />
              Refresh
            </Button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Keys grant access across this workspace. Client projects organize
            evidence; they are not separate security boundaries. Use separate
            deployments when clients require isolated data.
          </p>
          {error && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}
          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
              <label className="space-y-2 text-sm">
                Key name
                <Input
                  aria-label="Key name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  placeholder="Agency delivery pipeline"
                  required
                  disabled={busy || fetching || !loaded}
                />
              </label>
              <label className="space-y-2 text-sm">
                Expires in days
                <Input
                  aria-label="Expires in days"
                  type="number"
                  min="1"
                  max="90"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  required
                  disabled={busy || fetching || !loaded}
                />
              </label>
            </div>
            <fieldset
              disabled={busy || fetching || !loaded}
              className="grid gap-3 sm:grid-cols-2"
            >
              <legend className="mb-2 text-sm font-medium">Permissions</legend>
              {permissions.map(([scope, label]) => (
                <label className="flex items-center gap-2 text-sm" key={scope}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(e) => toggle(scope, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <p className="text-xs text-muted-foreground">
              Execution and assessment permissions can incur cloud usage. Live
              execution additionally requires configured provider keys.
            </p>
            <Button
              type="submit"
              disabled={
                busy || fetching || !loaded || !name.trim() || !scopes.length
              }
            >
              {busy ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <KeyRound size={16} />
              )}
              Create API key
            </Button>
          </form>
          {secret && (
            <div
              className="mt-5 space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4"
              role="status"
            >
              <p className="font-medium">
                Copy your key now. It is shown once.
              </p>
              <Input
                aria-label="New API key"
                type="password"
                value={secret}
                readOnly
                autoComplete="off"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(secret);
                      setCopied(true);
                    } catch {
                      setError(
                        "Clipboard unavailable. Select and copy the key field manually.",
                      );
                    }
                  }}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}Copy key
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSecret("")}>
                  Hide key
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Save it in your automation tool’s credential store. Solaris
                retains only its hash.
              </p>
            </div>
          )}
          <div className="mt-6 space-y-3">
            {fetching && <p role="status">Loading credentials…</p>}
            {loaded && !tokens.length && (
              <p className="text-sm text-muted-foreground">
                No integration keys yet. Create a read-only key first to connect
                your tool.
              </p>
            )}
            {tokens.map((token) => {
              const active =
                !token.revokedAt && Date.parse(token.expiresAt) > Date.now();
              return (
                <article key={token.id} className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <strong className="text-sm">{token.name}</strong>
                      <Badge variant="outline" className="ml-2">
                        {token.revokedAt
                          ? "Revoked"
                          : active
                            ? "Active"
                            : "Expired"}
                      </Badge>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {token.prefix}…
                      </p>
                    </div>
                    {active &&
                      (confirm === token.id ? (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy || fetching || !loaded}
                            onClick={() => void revoke(token.id)}
                          >
                            Confirm revoke
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirm(null)}
                          >
                            Keep key
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || fetching || !loaded}
                          onClick={() => setConfirm(token.id)}
                        >
                          Revoke
                        </Button>
                      ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {token.scopes.join(" · ")} · Expires{" "}
                    {new Date(token.expiresAt).toLocaleDateString()}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      )}
      <section className="rounded-xl border bg-card p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck size={20} />
          Automation API v1
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Use your workspace origin and an Authorization: Bearer header. A 202
          response acknowledges a job; only completed evidence and a passing
          gate establish the outcome. The example deliberately starts a
          diagnostic.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-muted p-4 text-xs">
          {JSON.stringify(AUTOMATION_SAMPLE, null, 2)}
        </pre>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Method / endpoint</th>
                <th className="p-2">Purpose</th>
                <th className="p-2">Scope</th>
              </tr>
            </thead>
            <tbody>
              {AUTOMATION_ENDPOINTS.map(([method, path, purpose, scope]) => (
                <tr key={path} className="border-t">
                  <td className="p-2 font-mono text-xs">
                    {method} {path}
                  </td>
                  <td className="p-2">{purpose}</td>
                  <td className="p-2 text-xs">{scope}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <a
          className="mt-4 inline-flex items-center gap-1 text-sm underline"
          href="https://github.com/ChariPramod/Solaris/blob/main/docs/INTEGRATIONS.md"
          target="_blank"
          rel="noreferrer"
        >
          Full integration guide and CI runner
          <ExternalLink size={13} />
        </a>
      </section>
    </div>
  );
}
