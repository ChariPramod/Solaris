/** Real production HTTP checks in an isolated project root; never calls live providers. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
async function main() {
  const web = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), "gauntlet-http-"));
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    GAUNTLET_PROJECT_ROOT: root,
    GAUNTLET_PYTHON:
      process.env.GAUNTLET_PYTHON || path.resolve(web, "../.venv/bin/python"),
  };
  for (const key of ["SOLARI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"])
    delete env[key as keyof typeof env];
  const server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: web, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let logs = "";
  server.stdout.on("data", (b) => {
    logs = (logs + b.toString()).slice(-5000);
  });
  server.stderr.on("data", (b) => {
    logs = (logs + b.toString()).slice(-5000);
  });
  const closed = new Promise<void>((resolve) =>
    server.once("exit", () => resolve()),
  );
  async function request(route: string, input?: unknown, expected = 200) {
    const response = await fetch(origin + route, {
      method: input === undefined ? "GET" : "POST",
      headers:
        input === undefined
          ? {}
          : { Origin: origin, "Content-Type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(110000),
    });
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(origin + "/api/runs");
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      if (server.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(ready, logs);
    const setup = {
      tasks: ["T01", "T02"],
      trials: 1,
      concurrency: 1,
      maxInfraFailures: 1,
      provider: "claude",
      modelId: "",
    };
    const first = await request("/api/dry-run", setup);
    assert.equal(first.ok, true);
    const before = await readFile(
      path.join(root, "results", first.id, "results.json"),
      "utf8",
    );
    const second = await request(`/api/runs/${first.id}/rerun`, setup);
    assert.equal(second.ok, true);
    assert.equal(second.warning, undefined);
    const history = await request(`/api/runs/${second.id}/attempts`);
    assert.equal(history.parents[0].parentId, first.id);
    const compare = await request(
      `/api/compare?candidate=${second.id}&baseline=${first.id}`,
    );
    assert.equal(compare.summary.transitions.unchanged, 2);
    assert.equal(compare.summary.transitions.inconclusive, 0);
    await request(
      `/api/compare?candidate=${first.id}&baseline=${first.id}`,
      undefined,
      422,
    );
    const gate = await request(`/api/runs/${second.id}/gate`, {
      policy: { schema_version: 1 },
    });
    assert.equal(gate.passed, false);
    const diagnostic = await request(`/api/runs/${second.id}/gate`, {
      baseline: first.id,
      policy: {
        schema_version: 1,
        require_live: false,
        min_pass_rate: 0,
        max_regressions: 0,
        max_total_cost_usd: 0,
      },
    });
    assert.equal(diagnostic.passed, true);
    const preset = await request("/api/presets", {
      revision: 0,
      name: "Integration smoke",
      setup,
    });
    assert.equal(preset.revision, 1);
    await request(
      "/api/presets",
      { id: preset.id, revision: 0, name: "Stale overwrite", setup },
      409,
    );
    const p2 = await request("/api/presets", {
      id: preset.id,
      revision: 1,
      name: "Integration smoke v2",
      setup,
    });
    assert.equal(p2.history.length, 2);
    const reviewURL = `/api/runs/${first.id}/trials/T01/1/review`;
    const review = await request(reviewURL);
    assert.equal(review.revision, 0);
    const input = {
      revision: 0,
      evidenceDigest: review.evidenceDigest,
      verdict: "needs-investigation",
      category: "agent",
      reviewer: "Integration check",
      note: "界".repeat(8000),
    };
    const saved = await request(reviewURL, input);
    assert.equal(saved.revision, 1);
    assert.equal(saved.note.length, 8000);
    await request(reviewURL, input, 409);
    await request(
      reviewURL,
      { ...input, revision: 1, note: "x".repeat(40001) },
      413,
    );
    assert.equal(
      await readFile(
        path.join(root, "results", first.id, "results.json"),
        "utf8",
      ),
      before,
      "Review must not modify original evidence",
    );
    const lock = path.join(root, ".gauntlet-workspace", ".write.lock");
    await writeFile(lock, "Integration test: simulated abandoned writer", {
      flag: "wx",
    });
    try {
      const unlinked = await request(`/api/runs/${first.id}/rerun`, setup);
      assert.equal(unlinked.ok, true);
      assert.ok(unlinked.id);
      assert.match(unlinked.warning, /link/);
      const readable = await request(`/api/runs/${unlinked.id}`);
      assert.equal(readable.id, unlinked.id);
    } finally {
      await unlink(lock);
    }
    const foreign = await fetch(origin + "/api/presets", {
      method: "POST",
      headers: {
        Origin: "https://example.com",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(foreign.status, 403);
    const artifact = await fetch(
      origin + `/api/runs/${first.id}/artifact?task=T01&trial=1&name=001.jpg`,
    );
    assert.equal(artifact.status, 200);
    assert.equal(artifact.headers.get("content-type"), "image/jpeg");
    console.log(
      "Production HTTP integration passed: dry run, linked rerun, comparison, gate, presets, review conflicts, Unicode limit, immutable evidence, link-write fallback and origin protection.",
    );
  } catch (e) {
    console.error(logs);
    throw e;
  } finally {
    server.kill("SIGTERM");
    await Promise.race([
      closed,
      delay(3000).then(() => server.kill("SIGKILL")),
    ]);
    await closed;
    await rm(root, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
