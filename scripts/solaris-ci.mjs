/** Dependency-free Solaris client for GitHub Actions, n8n execute-command and other CI runners. */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function runEvaluation(config, dependencies = {}) {
  const fetcher = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? delay;
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? console.log;
  const origin = new URL(config.url);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== config.url ||
    origin.username ||
    origin.password
  )
    throw new Error(
      "SOLARIS_URL must be the HTTPS workspace origin without a trailing slash.",
    );
  if (!/^solaris_[A-Za-z0-9_-]{43}$/.test(config.token ?? ""))
    throw new Error("Set SOLARIS_API_TOKEN to a scoped integration key.");
  const key = config.idempotencyKey ?? `ci-${randomUUID()}`;
  if (!/^[A-Za-z0-9_.:-]{16,128}$/.test(key))
    throw new Error("Invalid idempotency key; use 16–128 safe characters.");
  const headers = {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
  };
  async function request(path, input, launch = false) {
    for (let attempt = 0; attempt < (launch ? 3 : 1); attempt++) {
      let response;
      try {
        response = await fetcher(origin.origin + path, {
          method: input === undefined ? "GET" : "POST",
          headers: {
            ...headers,
            ...(launch ? { "Idempotency-Key": key } : {}),
          },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
          redirect: "error",
          signal: AbortSignal.timeout(240000),
        });
      } catch {
        if (launch && attempt < 2) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new Error(
          `Solaris request could not be confirmed. Keep idempotency key ${key}; inspect job status before another attempt.`,
        );
      }
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        // Launch retries share one identity. Assessment calls are not automatically replayed.
        if (
          launch &&
          [429, 502, 503, 504].includes(response.status) &&
          attempt < 2
        ) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw new Error(
          `Solaris ${path} returned HTTP ${response.status}. Inspect the workspace; original evidence is retained.`,
        );
      }
      if (!result || typeof result !== "object")
        throw new Error("Solaris returned an unreadable response.");
      return result;
    }
    throw new Error("Solaris launch could not be confirmed.");
  }
  log(`Starting ${config.mode} evaluation; idempotency key ${key}`);
  let job = await request(
    "/api/automation/v1/jobs",
    {
      mode: config.mode,
      setup: config.setup,
      ...(config.parentId ? { parentId: config.parentId } : {}),
    },
    true,
  );
  if (!/^cloud_[a-f0-9]{32}$/.test(job.id ?? ""))
    throw new Error("Solaris returned an invalid job identity.");
  const jobId = job.id;
  log(`Solaris job: ${jobId}`);
  const deadline = now() + (config.timeoutMs ?? 47 * 60000);
  while (["starting", "running", "cancelling"].includes(job.status)) {
    if (now() >= deadline)
      throw new Error(
        `Polling timed out for ${jobId}. The worker may continue; inspect it before another attempt.`,
      );
    await sleep(config.pollMs ?? 5000);
    job = await request(`/api/automation/v1/jobs/${jobId}`);
    if (job.id !== jobId)
      throw new Error("Solaris job identity changed while polling.");
  }
  if (job.status !== "complete")
    throw new Error(
      `Solaris job ${jobId} ended as ${job.status}; inspect its saved evidence.`,
    );
  const gate = await request(`/api/automation/v1/runs/${jobId}/gate`, {
    policy: config.policy,
    ...(config.baseline ? { baseline: config.baseline } : {}),
  });
  if (
    typeof gate.passed !== "boolean" ||
    !Array.isArray(gate.checks) ||
    !gate.checks.length ||
    ![jobId, `/vercel/sandbox/results/${jobId}`].includes(gate.run?.folder) ||
    gate.checks.some((check) => typeof check.passed !== "boolean") ||
    gate.passed !== gate.checks.every((check) => check.passed)
  )
    throw new Error(
      "Solaris returned an invalid or contradictory gate result.",
    );
  log(
    `Quality gate: ${gate.passed ? "PASSED" : "FAILED"} (${config.mode}; diagnostic results are not live reliability evidence)`,
  );
  return { jobId, gate, exitCode: gate.passed ? 0 : 1 };
}

export function configuration(env) {
  const mode = env.SOLARIS_MODE ?? "dry-run";
  if (!["dry-run", "live"].includes(mode))
    throw new Error("SOLARIS_MODE must be dry-run or live.");
  const tasks = (env.SOLARIS_TASKS ?? "T01,T02")
    .split(",")
    .map((v) => v.trim());
  if (
    !tasks.length ||
    new Set(tasks).size !== tasks.length ||
    tasks.some((v) => !/^T(?:0[1-9]|1[0-2])$/.test(v))
  )
    throw new Error("Choose unique shipped tasks T01–T12.");
  const provider = env.SOLARIS_PROVIDER ?? "claude";
  if (!["claude", "openai"].includes(provider))
    throw new Error("Choose claude or openai.");
  const trials = Number(env.SOLARIS_TRIALS ?? 1);
  if (!Number.isInteger(trials) || trials < 1 || trials > 3)
    throw new Error("Choose 1–3 trials.");
  return {
    url: env.SOLARIS_URL,
    token: env.SOLARIS_API_TOKEN,
    mode,
    setup: {
      tasks,
      trials,
      concurrency: 1,
      maxInfraFailures: 1,
      provider,
      modelId: env.SOLARIS_MODEL ?? "",
    },
    policy: JSON.parse(env.SOLARIS_GATE_POLICY ?? '{"schema_version":1}'),
    baseline: env.SOLARIS_BASELINE,
    idempotencyKey: env.SOLARIS_IDEMPOTENCY_KEY,
  };
}
async function main() {
  try {
    const result = await runEvaluation(configuration(process.env));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main();
