export type Trial = {
  task_id: string;
  trial: number;
  tier: number;
  model: string;
  mode: string;
  passed: boolean;
  steps: number;
  wall_seconds: number;
  termination: string;
  failure_class: string | null;
  failure_stage?: string | null;
  cleanup_error: string | null;
  error?: string | null;
  cost_usd: number | null;
  cost_status?: string;
  tokens_in: number;
  tokens_out: number;
  evidence: Record<string, unknown>;
  artifacts: string;
};
export type TaskDefinition = {
  id: string;
  name: string;
  tier: number;
  prompt: string;
  max_steps: number;
  max_seconds: number;
};
export type StopReason = {
  kind: string;
  limit: number;
  observed_failures: number;
  task_id: string;
  trial: number;
};
export type Run = {
  id: string;
  run_id?: string;
  created_at: string;
  mode: string;
  model: string;
  status: string;
  planned_trials: number;
  trials_per_task: number;
  task_ids: string[];
  records: Trial[];
  tasks: Record<string, { definition: TaskDefinition; sha256?: string }>;
  configuration: Record<string, unknown>;
  stop_reason?: StopReason;
  recovery?: Record<string, unknown>;
};
export type RunCard = Omit<Run, "records" | "tasks" | "configuration"> & {
  recorded: number;
  passed: number;
  infra: number;
  cleanup: number;
  cost: number | null;
};
export type Library = {
  runs: RunCard[];
  warnings: string[];
  source: "local" | "cloud";
  scannedAt: string;
};
export type ActionFrame = {
  step?: number;
  screenshot?: string;
  action?: { kind: string; params: Record<string, unknown> };
  response?: unknown;
  action_error?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number | null;
};
export type TrialDetail = {
  trial: Trial;
  frames: ActionFrame[];
  warnings: string[];
  screenshots: string[];
};
export type Check = {
  name: string;
  status: "pass" | "warning" | "fail";
  message: string;
};
export type Readiness = {
  ready: boolean;
  checks: Check[];
  scope: string;
  planned_trials: number;
};
export type Audit = {
  healthy: boolean;
  status: string;
  counts: Record<string, number>;
  findings: { severity: string; code: string; message: string }[];
  cleanup_candidates: unknown[];
};
export type RunSetup = {
  tasks: string[];
  trials: number;
  concurrency: number;
  maxInfraFailures: number;
  provider: "claude" | "openai";
  modelId: string;
};
