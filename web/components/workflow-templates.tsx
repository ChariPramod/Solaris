"use client";

import {
  ArrowUpRight,
  BriefcaseBusiness,
  FlaskConical,
  Repeat2,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  WORKFLOW_TEMPLATES,
  templateSetup,
  templateTaskName,
} from "@/lib/workflow-templates";
import type { RunSetup } from "@/lib/types";

const icons: Record<string, LucideIcon> = {
  smoke: FlaskConical,
  reliability: Repeat2,
  office: BriefcaseBusiness,
  safety: ShieldCheck,
};

export function WorkflowTemplates({
  onSelect,
  disabled = false,
  provider = "claude",
  modelId = "",
}: {
  onSelect: (setup: RunSetup) => void;
  disabled?: boolean;
  provider?: RunSetup["provider"];
  modelId?: string;
}) {
  return (
    <section aria-label="Workflow starter templates" className="space-y-5">
      <div className="max-w-2xl">
        <p className="eyebrow">START WITH A QUESTION</p>
        <h2 className="mt-2 text-xl font-semibold">
          A useful evaluation in a few clicks.
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Choose a task bundle, review its configuration, then run a diagnostic
          or a live agent. Every template uses shipped tasks with deterministic
          verifiers.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {WORKFLOW_TEMPLATES.map((template) => {
          const Icon = icons[template.id];
          return (
            <article
              key={template.id}
              className="flex min-w-0 flex-col rounded-xl border bg-card p-5 transition-colors hover:border-primary/40"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="rounded-lg border bg-primary/5 p-2.5 text-primary">
                  <Icon aria-hidden="true" className="size-5" />
                </span>
                <Badge variant="outline">
                  {template.tasks.length * template.trials} planned trials
                </Badge>
              </div>
              <h3 className="mt-4 text-lg font-semibold">{template.name}</h3>
              <p className="mt-1 text-sm text-primary">{template.purpose}</p>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {template.detail}
              </p>
              <ul
                className="my-4 flex flex-wrap gap-2"
                aria-label={`${template.name} tasks`}
              >
                {template.tasks.map((task) => (
                  <li
                    key={task}
                    className="rounded-md border bg-muted/30 px-2 py-1 text-xs"
                  >
                    <span className="mono mr-1.5 text-muted-foreground">
                      {task}
                    </span>
                    {templateTaskName(task)}
                  </li>
                ))}
              </ul>
              <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <span className="text-xs text-muted-foreground">
                  {template.trials} {template.trials === 1 ? "trial" : "trials"}{" "}
                  per task · 1 worker
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    onSelect(templateSetup(template.id, { provider, modelId }))
                  }
                  aria-label={`Configure ${template.name}`}
                >
                  Use template <ArrowUpRight aria-hidden="true" />
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Templates stop scheduling after the first infrastructure failure. You
        can adjust the model, trial count, concurrency, and failure limit before
        launch. Live execution requires configured provider credentials.
      </p>
    </section>
  );
}
