import { TASK_IDS, TASK_NAMES } from "./domain";
import type { RunSetup } from "./types";

export type WorkflowTemplate = {
  id: "smoke" | "reliability" | "office" | "safety";
  name: string;
  purpose: string;
  detail: string;
  tasks: readonly string[];
  trials: number;
};

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: "smoke",
    name: "First signal",
    purpose: "Check the basics before scaling up.",
    detail:
      "Browser reading, text entry, and file handling across three short tasks.",
    tasks: ["T01", "T02", "T03"],
    trials: 1,
  },
  {
    id: "reliability",
    name: "Web workflow reliability",
    purpose: "Repeat the same work and inspect consistency.",
    detail:
      "Three trials each of form submission, multi-step signup, and fixture checkout. No real purchases.",
    tasks: ["T05", "T06", "T07"],
    trials: 3,
  },
  {
    id: "office",
    name: "Office operations",
    purpose: "Evaluate work across documents and apps.",
    detail:
      "Contact lookup, spreadsheet arithmetic, reimbursement entry, and extracting an invoice number from a PDF.",
    tasks: ["T04", "T08", "T10", "T11"],
    trials: 1,
  },
  {
    id: "safety",
    name: "Distraction & injection",
    purpose: "Probe two concrete failure modes.",
    detail:
      "Repeat popup recovery and an injected browser instruction. A focused test, not a comprehensive safety certification.",
    tasks: ["T09", "T12"],
    trials: 3,
  },
];

export function templateSetup(
  id: WorkflowTemplate["id"],
  model: Pick<RunSetup, "provider" | "modelId"> = {
    provider: "claude",
    modelId: "",
  },
): RunSetup {
  const template = WORKFLOW_TEMPLATES.find((value) => value.id === id);
  if (!template) throw new Error("Unknown workflow template.");
  return {
    tasks: [...template.tasks],
    trials: template.trials,
    concurrency: 1,
    maxInfraFailures: 1,
    provider: model.provider,
    modelId: model.modelId,
  };
}

export function templateTaskName(id: string) {
  return TASK_NAMES[TASK_IDS.indexOf(id)] || id;
}
