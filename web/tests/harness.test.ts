import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  setupSchema,
  invoke,
  launchDryRun,
  checkReadiness,
  commonArgs,
} from "../lib/harness";
import { localRequest, body } from "../lib/http";
const setup = {
  tasks: ["T01", "T02"],
  trials: 1,
  concurrency: 1,
  maxInfraFailures: 1,
  provider: "claude" as const,
  modelId: "",
};
async function fakePython(t: TestContext, source: string) {
  const folder = await mkdtemp(path.join(tmpdir(), "gauntlet-process-"));
  const file = path.join(folder, "python");
  await writeFile(file, `#!/usr/bin/env node\n${source}`);
  await chmod(file, 0o700);
  const previous = process.env.GAUNTLET_PYTHON;
  process.env.GAUNTLET_PYTHON = file;
  t.after(async () => {
    if (previous === undefined) delete process.env.GAUNTLET_PYTHON;
    else process.env.GAUNTLET_PYTHON = previous;
    await rm(folder, { recursive: true, force: true });
  });
  return file;
}
test("launch schema rejects live controls, unknown keys, duplicates, and out-of-bounds requests", () => {
  for (const value of [
    { ...setup, live: true },
    { ...setup, out: "/tmp" },
    { ...setup, tasks: ["T99"] },
    { ...setup, tasks: ["T01", "T01"] },
    { ...setup, trials: 4 },
    { ...setup, concurrency: 3 },
    { ...setup, maxInfraFailures: 0 },
    { ...setup, modelId: "$(bad)" },
    { ...setup, tasks: [] },
  ])
    assert.equal(setupSchema.safeParse(value).success, false);
  assert.equal(setupSchema.safeParse(setup).success, true);
  assert.deepEqual(commonArgs(setup), [
    "--tasks",
    "T01,T02",
    "--trials",
    "1",
    "--concurrency",
    "1",
    "--max-infra-failures",
    "1",
  ]);
});
test("mutations require matching loopback origin and JSON", () => {
  const request = (host: string, origin?: string) =>
    new Request("http://localhost:3000/api/dry-run", {
      headers: {
        host,
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
    });
  assert.doesNotThrow(() =>
    localRequest(request("127.0.0.1:3000", "http://127.0.0.1:3000"), true),
  );
  assert.throws(() =>
    localRequest(request("evil.example", "http://evil.example"), true),
  );
  assert.throws(() =>
    localRequest(request("localhost:3000", "https://evil.example"), true),
  );
  assert.throws(() => localRequest(request("localhost:3000"), true));
  assert.throws(() =>
    localRequest(request("localhost:3000", "http://localhost:3001"), true),
  );
});
test("malformed and oversized request bodies fail explicitly", async () => {
  await assert.rejects(
    body(new Request("http://localhost", { method: "POST", body: "x" })),
  );
  await assert.rejects(
    body(
      new Request("http://localhost", {
        method: "POST",
        body: " ".repeat(8193),
      }),
    ),
    /large/,
  );
});
test("missing Python is actionable and releases the launch lock", async (t) => {
  const old = process.env.GAUNTLET_PYTHON;
  process.env.GAUNTLET_PYTHON = "/no-such-gauntlet/python";
  t.after(() => {
    if (old === undefined) delete process.env.GAUNTLET_PYTHON;
    else process.env.GAUNTLET_PYTHON = old;
  });
  await assert.rejects(launchDryRun(setup), /Python harness is unavailable/);
  await assert.rejects(launchDryRun(setup), /Python harness is unavailable/);
});
test("credential-free subprocess strips model and desktop keys", async (t) => {
  await fakePython(
    t,
    "console.log(JSON.stringify({keys:['SOLARI_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY'].filter(k=>process.env[k]),args:process.argv.slice(2)}));",
  );
  const keys = ["SOLARI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const key of keys) process.env[key] = "TEST-ONLY";
  t.after(() => {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  });
  const result = await invoke(["run", "--dry-run"], 1000, true);
  assert.deepEqual(JSON.parse(result.stdout).keys, []);
  assert.deepEqual(JSON.parse(result.stdout).args, [
    "-m",
    "gauntlet",
    "run",
    "--dry-run",
  ]);
});
test("timeout interrupts a hung subprocess", async (t) => {
  await fakePython(
    t,
    "process.on('SIGINT',()=>process.exit(130));setInterval(()=>{},100);",
  );
  const result = await invoke(["run", "--dry-run"], 150, true);
  assert.equal(result.timedOut, true);
});
test("only one launch runs at a time and CLI dry-run is forced", async (t) => {
  await fakePython(
    t,
    "if(!process.argv.includes('--dry-run'))process.exit(9);setTimeout(()=>process.exit(2),120);",
  );
  const first = launchDryRun(setup);
  await assert.rejects(launchDryRun(setup), /already in progress/);
  const result = await first;
  assert.equal(result.ok, false);
  assert.equal(result.id, null);
  assert.equal(result.exitCode, 2);
  const second = await launchDryRun(setup);
  assert.equal(second.exitCode, 2);
});
test("preflight exit one is a valid response with failed checks", async (t) => {
  await fakePython(
    t,
    "console.log(JSON.stringify({ready:false,checks:[{name:'credential',status:'fail'}]}));process.exitCode=1;",
  );
  const result = await checkReadiness({ setup, dryRun: false });
  assert.equal(result.ready, false);
});
