"use client";

import { useState } from "react";
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
} from "lucide-react";
import { Button } from "./ui/button";
import type { Library } from "@/lib/types";

export function WorkspaceIntro({
  library,
  onOpen,
  onCreate,
  onReadiness,
}: {
  library: Library | null;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onReadiness: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const complete =
    library?.runs.filter(
      (run) =>
        run.status === "complete" &&
        run.recorded === run.planned_trials &&
        run.recorded > 0 &&
        run.infra === 0 &&
        run.cleanup === 0,
    ) ?? [];
  const latest = [...complete].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  )[0];
  const live = library?.runs.filter((run) => run.mode === "live").length ?? 0;
  return (
    <section
      className="mb-6 overflow-hidden rounded-xl border bg-card"
      aria-label="Getting started"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 p-5">
        <div className="max-w-2xl">
          <p className="eyebrow">START HERE</p>
          <h2 className="mt-2 text-lg font-semibold">
            Can an AI finish the job? Follow the evidence.
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Choose a computer task, run an agent, then inspect what actually
            happened. Solaris keeps each attempt so you can investigate failures
            and compare changes.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls="getting-started-steps"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp /> : <ChevronDown />}
          {expanded ? "Hide guide" : "Show guide"}
        </Button>
      </div>
      {expanded && (
        <div id="getting-started-steps" className="border-t p-5">
          <ol className="grid gap-5 md:grid-cols-3">
            <li>
              <p className="text-sm font-semibold">01 · Check the workflow</p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                A diagnostic run executes the harness without calling an AI
                provider. Expected task failures test reporting; they are not
                benchmark scores.
              </p>
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                onClick={onCreate}
              >
                Configure an evaluation <ArrowRight />
              </Button>
            </li>
            <li>
              <p className="text-sm font-semibold">
                02 · Inspect a real saved attempt
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Open a trial, read its verifier outcome and evidence, then add a
                review. Compare compatible attempts and apply a quality gate.
              </p>
              {latest ? (
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => onOpen(latest.id)}
                >
                  Inspect latest{" "}
                  {latest.mode === "live" ? "live run" : "diagnostic"}{" "}
                  <BookOpen />
                </Button>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  {library
                    ? "A completed run will appear here once evidence is saved."
                    : "Loading saved evidence…"}
                </p>
              )}
            </li>
            <li>
              <p className="text-sm font-semibold">
                03 · Validate with a live agent
              </p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Connect Solari and your model provider on the server. Start
                small, review task outcomes and desktop cleanup, then expand the
                evaluation.
              </p>
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                onClick={onReadiness}
              >
                Check live setup <ShieldCheck />
              </Button>
            </li>
          </ol>
          <p
            className="mt-5 border-t pt-4 text-xs leading-relaxed text-muted-foreground"
            role="status"
          >
            {!library
              ? "Evidence status is loading."
              : live
                ? `${live} saved live evaluation${live === 1 ? "" : "s"}. Saved evidence still needs human review before making reliability claims.`
                : "No live evaluations are saved in this library. Diagnostic results demonstrate the workflow, not AI performance."}{" "}
            <a
              className="underline underline-offset-4"
              href="https://github.com/ChariPramod/Solaris/blob/main/docs/PRODUCT_READINESS.md"
              target="_blank"
              rel="noreferrer"
            >
              Product status and limitations
            </a>
          </p>
        </div>
      )}
    </section>
  );
}
