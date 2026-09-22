import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { PROJECT_ROOT, readRun, StoreError } from "./store";
import { TASK_IDS } from "./domain";
export const setupSchema = z
  .object({
    tasks: z
      .array(z.enum(TASK_IDS as [string, ...string[]]))
      .min(1)
      .max(12)
      .refine((v) => new Set(v).size === v.length, "Select each task once."),
    trials: z.number().int().min(1).max(3),
    concurrency: z.number().int().min(1).max(2),
    maxInfraFailures: z.number().int().min(1).max(3),
    provider: z.enum(["claude", "openai"]),
    modelId: z
      .string()
      .max(160)
      .regex(/^[A-Za-z0-9._:/-]*$/),
  })
  .strict();
export type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};
export function invoke(
  args: string[],
  timeout = 30000,
  credentialFree = false,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (credentialFree)
      for (const key of [
        "SOLARI_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
      ])
        delete env[key];
    const child = spawn(
      /* turbopackIgnore: true */ process.env.GAUNTLET_PYTHON ||
        path.join(PROJECT_ROOT, ".venv/bin/python"),
      ["-m", "gauntlet", ...args],
      {
        cwd: PROJECT_ROOT,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      timedOut = true;
      child.kill("SIGINT");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    const timer = setTimeout(stop, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2 * 1024 * 1024) {
        stdout = stdout.slice(0, 2 * 1024 * 1024);
        if (!timedOut) stop();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-16000);
    });
    child.on("error", () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(
        new StoreError(
          "Python harness is unavailable. Install the project environment or set GAUNTLET_PYTHON. Existing runs can still be browsed.",
          503,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
export function commonArgs(value: z.infer<typeof setupSchema>) {
  return [
    "--tasks",
    value.tasks.join(","),
    "--trials",
    String(value.trials),
    "--concurrency",
    String(value.concurrency),
    "--max-infra-failures",
    String(value.maxInfraFailures),
  ];
}
export async function checkReadiness(raw: unknown) {
  const parsed = z
    .object({ setup: setupSchema, dryRun: z.boolean() })
    .strict()
    .parse(raw);
  const { setup, dryRun } = parsed;
  const args = [
    "preflight",
    ...commonArgs(setup),
    "--model",
    setup.provider,
    "--json",
  ];
  if (dryRun) args.push("--dry-run");
  if (setup.modelId) args.push("--model-id", setup.modelId);
  const result = await invoke(args, 30000, dryRun);
  if (result.timedOut || ![0, 1].includes(result.code ?? -1))
    throw new StoreError(
      "Readiness check could not finish. Retry or use the terminal preflight command.",
      503,
    );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new StoreError("Readiness returned an unreadable response.", 503);
  }
}
const runtime = globalThis as typeof globalThis & {
  gauntletDryRun?: Promise<unknown>;
};
export async function launchDryRun(raw: unknown) {
  const setup = setupSchema.parse(raw);
  if (runtime.gauntletDryRun)
    throw new StoreError(
      "A workspace dry run is already in progress. Wait for it to finish, then refresh.",
      409,
    );
  const id = `web_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${randomUUID().slice(0, 8)}`;
  const job = (async () => {
    const result = await invoke(
      [
        "run",
        "--dry-run",
        ...commonArgs(setup),
        "--out",
        path.join(PROJECT_ROOT, "results", id),
      ],
      90000,
      true,
    );
    let saved = false;
    try {
      await readRun(id);
      saved = true;
    } catch {}
    if (result.timedOut)
      return {
        id: saved ? id : null,
        ok: false,
        message:
          "The dry run timed out. Any saved evidence remains available; audit it before retrying.",
        exitCode: result.code,
      };
    if (result.code !== 0)
      return {
        id: saved ? id : null,
        ok: false,
        message:
          "The harness reported an error. Inspect saved evidence or run the command in your terminal.",
        exitCode: result.code,
      };
    if (!saved)
      throw new StoreError(
        "The process ended without a readable result. Inspect the local results folder.",
        503,
      );
    return {
      id,
      ok: true,
      message:
        "Dry run completed. Failed state checks are expected with the static agent.",
      exitCode: 0,
    };
  })();
  runtime.gauntletDryRun = job;
  try {
    return await job;
  } finally {
    delete runtime.gauntletDryRun;
  }
}
