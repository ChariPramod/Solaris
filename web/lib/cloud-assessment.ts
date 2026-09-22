import { Sandbox } from "@vercel/sandbox";
import { z } from "zod";
import { comparisonSchema, gateRequestSchema, gateSchema } from "./assessment";
import { getCloudEvidenceFiles } from "./cloud-artifacts";
import { StoreError } from "./store";

type EvidenceFile = { path: string; content: Buffer };
type Command = {
  exitCode: number;
  logs(options?: { signal?: AbortSignal }): AsyncIterable<{
    stream: string;
    data: string;
  }>;
};
type SandboxClient = {
  runCommand(options: {
    cmd: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<Command>;
  writeFiles(
    files: EvidenceFile[],
    options: { signal: AbortSignal },
  ): Promise<void>;
  stop(options: { signal: AbortSignal }): Promise<unknown>;
};
type Dependencies = {
  read: (id: string) => Promise<EvidenceFile[]>;
  create: (
    options: Parameters<typeof Sandbox.create>[0],
  ) => Promise<SandboxClient>;
  revision: () => string | undefined;
};
const defaults: Dependencies = {
  read: getCloudEvidenceFiles,
  create: (options) => Sandbox.create(options),
  revision: () =>
    process.env.GAUNTLET_SOURCE_REVISION || process.env.VERCEL_GIT_COMMIT_SHA,
};
const ROOT = "/vercel/sandbox";
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_EVIDENCE = 128 * 1024 * 1024;

function identifier(id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id))
    throw new StoreError("Invalid run identifier.");
  return id;
}

async function assessment<T extends { warnings: string[] }>(
  ids: string[],
  args: string[],
  schema: z.ZodType<T>,
  policy: unknown,
  deps: Dependencies,
): Promise<T> {
  ids.forEach(identifier);
  const revision = deps.revision();
  if (!revision || !/^[a-f0-9]{40}$/i.test(revision))
    throw new StoreError(
      "Cloud assessment requires a pinned source revision. Saved evidence is unchanged.",
      503,
    );
  // Read and validate everything before allocating a worker. Never execute uploaded code.
  let bytes = 0;
  const files: EvidenceFile[] = [];
  for (const id of new Set(ids)) {
    const seen = new Set<string>();
    for (const file of await deps.read(id)) {
      const segments = file.path.split("/");
      if (
        segments.some((part) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part)) ||
        ![
          "results.json",
          "task.json",
          "result.json",
          "lifecycle.jsonl",
        ].includes(segments.at(-1)!) ||
        seen.has(file.path)
      )
        throw new StoreError(
          "Cloud evidence contains an unsafe or duplicate path.",
          422,
        );
      seen.add(file.path);
      bytes += file.content.byteLength;
      if (bytes > MAX_EVIDENCE)
        throw new StoreError(
          "Assessment evidence exceeds the 128 MiB limit.",
          413,
        );
      files.push({
        path: `${ROOT}/results/${id}/${file.path}`,
        content: file.content,
      });
    }
    if (!seen.has("results.json"))
      throw new StoreError("Cloud evidence is missing its manifest.", 422);
  }
  if (policy !== undefined)
    files.push({
      path: `${ROOT}/gate-policy.json`,
      content: Buffer.from(JSON.stringify(policy)),
    });

  const signal = AbortSignal.timeout(180_000);
  let sandbox: SandboxClient | undefined;
  let decoded: T | undefined;
  try {
    sandbox = await deps.create({
      source: {
        type: "git",
        url: "https://github.com/ChariPramod/Solaris.git",
        revision,
      },
      runtime: "python3.13",
      persistent: false,
      timeout: 210_000,
      resources: { vcpus: 2 },
      signal,
      // Deliberately no host environment or provider credentials in this worker.
      env: { PIP_DISABLE_PIP_VERSION_CHECK: "1" },
    });
    const install = await sandbox.runCommand({
      cmd: "python",
      args: ["-m", "pip", "install", "--quiet", "-e", "."],
      cwd: ROOT,
      timeoutMs: 90_000,
      signal,
    });
    if (install.exitCode !== 0)
      throw new StoreError(
        "Assessment worker setup failed. Saved evidence is unchanged; retry or use the CLI.",
        503,
      );
    await sandbox.writeFiles(files, { signal });
    const command = await sandbox.runCommand({
      cmd: "python",
      args: ["-m", "gauntlet", ...args],
      cwd: ROOT,
      timeoutMs: 45_000,
      signal,
    });
    let output = "";
    let size = 0;
    for await (const chunk of command.logs({ signal })) {
      size += Buffer.byteLength(chunk.data);
      if (size > MAX_OUTPUT)
        throw new StoreError(
          "Assessment output exceeded its limit. Saved evidence is unchanged.",
          503,
        );
      if (chunk.stream === "stdout") output += chunk.data;
    }
    const allowed = args[0] === "gate" ? [0, 1] : [0];
    if (!allowed.includes(command.exitCode)) {
      let message =
        "Cloud assessment failed. Saved evidence is unchanged; retry or use the CLI.";
      if (command.exitCode === 2) {
        try {
          const error = JSON.parse(output).error;
          if (typeof error === "string") message = error.slice(0, 2000);
        } catch {}
      }
      throw new StoreError(message, command.exitCode === 2 ? 422 : 503);
    }
    try {
      decoded = schema.parse(JSON.parse(output));
      if (
        args[0] === "gate" &&
        (decoded as T & { passed: boolean }).passed !== (command.exitCode === 0)
      )
        throw new Error("Gate result conflicts with exit status");
    } catch {
      throw new StoreError(
        "Assessment returned invalid output. Saved evidence is unchanged.",
        503,
      );
    }
    return decoded;
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(
      "Cloud assessment is unavailable or timed out. Saved evidence is unchanged; retry or use the CLI.",
      503,
    );
  } finally {
    if (sandbox) {
      try {
        await sandbox.stop({ signal: AbortSignal.timeout(10_000) });
      } catch {
        // The VM has a provider-enforced lifetime even if stop acknowledgement is lost.
        decoded?.warnings.push(
          "Assessment worker cleanup was not acknowledged. Its automatic timeout remains in effect.",
        );
      }
    }
  }
}

export async function compareCloudRuns(
  candidate: string,
  baseline: string,
  deps = defaults,
) {
  return assessment(
    [candidate, baseline],
    [
      "compare",
      `${ROOT}/results/${candidate}`,
      "--baseline",
      `${ROOT}/results/${baseline}`,
      "--json",
    ],
    comparisonSchema,
    undefined,
    deps,
  );
}

export async function assessCloudGate(
  id: string,
  raw: unknown,
  deps = defaults,
) {
  const { policy, baseline } = gateRequestSchema.parse(raw);
  if (policy.max_regressions !== undefined && !baseline)
    throw new StoreError("Select a baseline when setting a regression limit.");
  const args = [
    "gate",
    `${ROOT}/results/${id}`,
    "--policy",
    `${ROOT}/gate-policy.json`,
    "--json",
  ];
  if (baseline) args.push("--baseline", `${ROOT}/results/${baseline}`);
  return assessment(
    baseline ? [id, baseline] : [id],
    args,
    gateSchema,
    policy,
    deps,
  );
}
