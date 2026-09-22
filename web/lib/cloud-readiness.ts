import { z } from "zod";
import { setupSchema } from "./harness";
import type { Check, Readiness } from "./types";
import { listKeys } from "./cloud-storage";
const inputSchema = z.union([
  setupSchema,
  // Older workspace clients send the local preflight envelope. This endpoint
  // checks live readiness only; accepting dryRun:true would misstate its scope.
  z
    .object({ setup: setupSchema, dryRun: z.literal(false) })
    .strict()
    .transform(({ setup }) => setup),
]);
type Dependencies = {
  env?: Record<string, string | undefined>;
  listKeys?: typeof listKeys;
};
export async function checkCloudReadiness(
  raw: unknown,
  deps: Dependencies = {},
): Promise<Readiness> {
  const setup = inputSchema.parse(raw);
  const env = deps.env ?? process.env;
  const checks: Check[] = [];
  for (const [name, key] of [
    ["Computer provider", "SOLARI_API_KEY"],
    [
      "Model provider",
      setup.provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY",
    ],
  ]) {
    const configured = Boolean(env[key]?.trim());
    checks.push({
      name,
      status: configured ? "pass" : "fail",
      message: configured
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
    await (deps.listKeys ?? listKeys)("jobs/", 1);
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
  const revision = env.GAUNTLET_SOURCE_REVISION || env.VERCEL_GIT_COMMIT_SHA;
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
