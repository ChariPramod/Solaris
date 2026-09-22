import { setupSchema } from "./harness";
import type { Check, Readiness } from "./types";
import { listKeys } from "./cloud-storage";
export async function checkCloudReadiness(raw: unknown): Promise<Readiness> {
  const setup = setupSchema.parse(raw);
  const checks: Check[] = [];
  for (const [name, key] of [
    ["Computer provider", "SOLARI_API_KEY"],
    [
      "Model provider",
      setup.provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY",
    ],
  ]) {
    checks.push({
      name,
      status: process.env[key] ? "pass" : "fail",
      message: process.env[key]
        ? "Server credential configured; live authentication is checked when execution starts."
        : `Configure ${key} in Vercel environment variables to run live evaluations.`,
    });
  }
  if (setup.provider === "openai" && !setup.modelId)
    checks.push({
      name: "Model",
      status: "fail",
      message: "Select an OpenAI model.",
    });
  try {
    await listKeys("jobs/", 1);
    checks.push({
      name: "Durable storage",
      status: "pass",
      message: "Private evidence storage is reachable.",
    });
  } catch {
    checks.push({
      name: "Durable storage",
      status: "fail",
      message:
        "Private storage is unavailable. Existing evidence is preserved.",
    });
  }
  const revision =
    process.env.GAUNTLET_SOURCE_REVISION || process.env.VERCEL_GIT_COMMIT_SHA;
  checks.push({
    name: "Execution source",
    status: revision && /^[a-f0-9]{40}$/i.test(revision) ? "pass" : "fail",
    message:
      revision && /^[a-f0-9]{40}$/i.test(revision)
        ? "Worker runs the pinned published source. Sandbox availability is checked at launch."
        : "Publish and pin the worker source before launching.",
  });
  return {
    ready: checks.every((c) => c.status !== "fail"),
    checks,
    scope:
      "Cloud configuration and storage; provider credentials are not exercised by this check.",
    planned_trials: setup.tasks.length * setup.trials,
  };
}
