import test from "node:test";
import assert from "node:assert/strict";
import { createCloudRunner, type CloudJob } from "../lib/cloud-runner";
import { StoreError } from "../lib/store";
import type { RunSetup } from "../lib/types";

const setup: RunSetup = {
  tasks: ["T01"],
  trials: 1,
  concurrency: 1,
  maxInfraFailures: 1,
  provider: "claude",
  modelId: "",
};
const origin = "https://solaris.example.com";
function fixture(
  overrides: {
    launchError?: boolean;
    prepareError?: boolean;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const data = new Map<string, { value: unknown; etag: string }>();
  const commands: unknown[] = [];
  const provisions: unknown[] = [];
  let clock = 1_800_000_000_000;
  let stopped = 0;
  const runner = createCloudRunner({
    now: () => clock,
    env: { GAUNTLET_SOURCE_REVISION: "a".repeat(40), ...overrides.env },
    store: {
      async readJSON<T>(key: string) {
        const row = data.get(key);
        return row
          ? { value: structuredClone(row.value) as T, etag: row.etag }
          : null;
      },
      async writeJSON(key: string, value: unknown, expected: string | null) {
        if ((data.get(key)?.etag ?? null) !== expected)
          throw new StoreError("Conflict", 409);
        const etag = String(Number(expected ?? "0") + 1);
        data.set(key, { value: structuredClone(value), etag });
        return { etag };
      },
    },
    createSandbox: async (options) => {
      provisions.push(options);
      if (overrides.prepareError)
        throw new Error("credential secret must not escape");
      return {
        name: "sandbox-one",
        currentSession: () => ({ sessionId: "session-one" }),
        runCommand: async (command: unknown) => {
          const job = [...data.values()][0].value as CloudJob;
          assert.equal(
            job.sandboxId,
            "sandbox-one",
            "allocation must persist before execution",
          );
          commands.push(command);
          if (overrides.launchError)
            throw new Error("ambiguous transport failure secret");
          return { cmdId: "command-one" };
        },
        stop: async () => {
          stopped++;
        },
      } as never;
    },
  });
  return {
    runner,
    data,
    commands,
    provisions,
    advance: () => {
      clock += 46 * 60_000;
    },
    stopped: () => stopped,
  };
}

test("cloud execution persists allocation and launches a pinned detached once-only worker", async () => {
  const f = fixture({
    env: {
      SOLARI_API_KEY: "desktop-secret",
      ANTHROPIC_API_KEY: "provider-secret",
    },
  });
  const result = await f.runner.startCloudRun(setup, "dry-run", origin);
  assert.equal(result.status, "running");
  assert.equal(result.commandId, "command-one");
  assert.equal("callbackToken" in result, false);
  assert.equal(f.commands.length, 1);
  const command = f.commands[0] as {
    env: Record<string, string>;
    detached: boolean;
    args: string[];
  };
  assert.equal(command.detached, true);
  assert.deepEqual(command.args, ["-m", "gauntlet.cloud_worker"]);
  assert.equal(command.env.SOLARI_API_KEY, undefined);
  assert.equal(command.env.ANTHROPIC_API_KEY, undefined);
  const config = JSON.parse(command.env.GAUNTLET_CLOUD_CONFIG);
  assert.equal(config.callbackUrl, `${origin}/api/cloud/ingest`);
  assert.match(config.token, /^[a-f0-9]{64}$/);
  assert.equal((f.provisions[0] as { persistent: boolean }).persistent, false);
});

test("live worker receives only the selected provider keys", async () => {
  const f = fixture({
    env: {
      SOLARI_API_KEY: "solari",
      ANTHROPIC_API_KEY: "claude",
      OPENAI_API_KEY: "unused",
      RANDOM_SECRET: "unused",
    },
  });
  await f.runner.startCloudRun(setup, "live", origin);
  const { env } = f.commands[0] as { env: Record<string, string> };
  assert.equal(env.SOLARI_API_KEY, "solari");
  assert.equal(env.ANTHROPIC_API_KEY, "claude");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.RANDOM_SECRET, undefined);
});

test("missing credentials, unpinned source and unsafe origin fail before provisioning", async () => {
  for (const operation of [
    (f: ReturnType<typeof fixture>) =>
      f.runner.startCloudRun(setup, "live", origin),
    (f: ReturnType<typeof fixture>) =>
      f.runner.startCloudRun(setup, "dry-run", "http://localhost:3000"),
    (f: ReturnType<typeof fixture>) =>
      f.runner.startCloudRun(setup, "dry-run", "https://user:pass@example.com"),
  ]) {
    const f = fixture();
    await assert.rejects(operation(f));
    assert.equal(f.data.size, 0);
    assert.equal(f.provisions.length, 0);
  }
  const f = fixture({ env: { GAUNTLET_SOURCE_REVISION: "main" } });
  await assert.rejects(
    f.runner.startCloudRun(setup, "dry-run", origin),
    /source commit/,
  );
  assert.equal(f.provisions.length, 0);
});

test("ambiguous detached launch is recorded without automatic replay or stopping a possibly active worker", async () => {
  const f = fixture({ launchError: true });
  const job = await f.runner.startCloudRun(setup, "dry-run", origin);
  assert.equal(job.status, "interrupted");
  assert.equal(f.commands.length, 1);
  assert.equal(f.provisions.length, 1);
  assert.equal(f.stopped(), 0);
  assert.doesNotMatch(job.error!, /secret/);
});

test("preparation errors remain durable and do not launch evaluation", async () => {
  const f = fixture({ prepareError: true });
  const job = await f.runner.startCloudRun(setup, "dry-run", origin);
  assert.equal(job.status, "failed");
  assert.equal(f.commands.length, 0);
  assert.equal(f.data.size, 1);
  assert.doesNotMatch(job.error!, /secret/);
});

test("expired jobs reconcile to interrupted while completed jobs remain complete", async () => {
  const f = fixture();
  const job = await f.runner.startCloudRun(setup, "dry-run", origin);
  f.advance();
  assert.equal(
    (await f.runner.getPublicCloudJob(job.id)).status,
    "interrupted",
  );
  await f.runner.updateCloudJob(job.id, (current) => ({
    ...current,
    status: "complete",
    exitCode: 3,
  }));
  assert.equal((await f.runner.getPublicCloudJob(job.id)).status, "complete");
  assert.equal(
    "callbackToken" in (await f.runner.getPublicCloudJob(job.id)),
    false,
  );
});

test("invalid job identities cannot reach storage", async () => {
  const f = fixture();
  await assert.rejects(f.runner.getCloudJob("../secret"), /Invalid/);
  await assert.rejects(
    f.runner.updateCloudJob("../secret", (x) => x),
    /Invalid/,
  );
});

test("corrupt stored jobs fail closed without resetting their records", async () => {
  const f = fixture();
  const job = await f.runner.startCloudRun(setup, "dry-run", origin);
  const key = `jobs/${job.id}.json`;
  const row = f.data.get(key)!;
  (row.value as CloudJob).expiresAt = "not-a-date";
  await assert.rejects(f.runner.getPublicCloudJob(job.id), /data is invalid/);
  await assert.rejects(
    f.runner.updateCloudJob(job.id, (x) => x),
    /data is invalid/,
  );
  assert.equal(f.data.get(key)?.etag, row.etag);
});

test("cancellation is durable, idempotent and does not directly kill the sandbox", async () => {
  const f = fixture();
  const job = await f.runner.startCloudRun(setup, "dry-run", origin);
  const first = await f.runner.cancelCloudJob(job.id);
  const second = await f.runner.cancelCloudJob(job.id);
  assert.equal(first.status, "cancelling");
  assert.ok(first.cancelRequestedAt);
  assert.equal(second.cancelRequestedAt, first.cancelRequestedAt);
  assert.equal("callbackToken" in first, false);
  assert.equal(f.stopped(), 0);
  assert.equal(f.commands.length, 1);
  f.advance();
  assert.equal(
    (await f.runner.getPublicCloudJob(job.id)).status,
    "interrupted",
  );
  await assert.rejects(f.runner.cancelCloudJob(job.id), /expired/);
});

test("cancellation never rewrites terminal results or claims unsupported older workers stopped", async () => {
  const f = fixture();
  const job = await f.runner.startCloudRun(setup, "dry-run", origin);
  await f.runner.updateCloudJob(job.id, (value) => ({
    ...value,
    controlVersion: undefined,
  }));
  await assert.rejects(f.runner.cancelCloudJob(job.id), /older worker/);
  for (const status of ["complete", "failed", "cancelled"] as const) {
    await f.runner.updateCloudJob(job.id, (value) => ({ ...value, status }));
    assert.equal((await f.runner.cancelCloudJob(job.id)).status, status);
  }
});

test("cancellation and completion racing through CAS preserve the terminal outcome", async () => {
  const f = fixture();
  const job = await f.runner.startCloudRun(setup, "dry-run", origin);
  await Promise.all([
    f.runner.cancelCloudJob(job.id),
    f.runner.updateCloudJob(job.id, (value) => ({
      ...value,
      status: "complete",
      exitCode: 3,
    })),
  ]);
  assert.equal((await f.runner.getPublicCloudJob(job.id)).status, "complete");
  assert.equal(f.commands.length, 1);
});
