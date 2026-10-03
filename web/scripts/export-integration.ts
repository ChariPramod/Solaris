/** Run after next build. Uses an isolated local project; no provider or production data. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "solaris-export-http-"));
  const port = await new Promise<number>((resolve, reject) => {
    const listener = createServer();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const port = (listener.address() as { port: number }).port;
      listener.close(() => resolve(port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
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
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GAUNTLET_STORAGE: "local",
        GAUNTLET_PROJECT_ROOT: root,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  server.stdout.on("data", (bytes) => {
    logs = (logs + bytes.toString()).slice(-5000);
  });
  server.stderr.on("data", (bytes) => {
    logs = (logs + bytes.toString()).slice(-5000);
  });
  const closed = new Promise<void>((resolve) =>
    server.once("exit", () => resolve()),
  );
  try {
    const directory = path.join(root, "results/export_http/T01/1");
    await mkdir(directory, { recursive: true });
    const record = {
      task_id: "T01",
      trial: 1,
      tier: 1,
      model: "dry-run",
      mode: "dry-run",
      passed: false,
      steps: 1,
      wall_seconds: 0.1,
      termination: "max_steps",
      failure_class: "task_failure",
      cleanup_error: null,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      evidence: {},
      artifacts: "T01/1",
    };
    const manifest = {
      schema_version: 2,
      run_id: "http-original",
      created_at: "2026-10-02T00:00:00Z",
      mode: "dry-run",
      model: "dry-run",
      status: "complete",
      planned_trials: 1,
      trials_per_task: 1,
      task_ids: ["T01"],
      records: [record],
    };
    await writeFile(
      path.join(root, "results/export_http/results.json"),
      JSON.stringify(manifest),
    );
    await writeFile(
      path.join(directory, "result.json"),
      JSON.stringify(record),
    );
    await writeFile(
      path.join(directory, "task.json"),
      JSON.stringify({ definition: { id: "T01" } }),
    );
    for (const name of ["001.jpg", "002.jpg", "final.jpg"])
      await writeFile(path.join(directory, name), randomBytes(2 * 1024 * 1024));
    let ready = false;
    for (let count = 0; count < 100; count++) {
      try {
        if ((await fetch(`${origin}/api/runs`)).ok) {
          ready = true;
          break;
        }
      } catch {}
      if (server.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(ready, logs);
    const denied = await fetch(`${origin}/api/runs/export_http/bundle`, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(denied.status, 403);
    const response = await fetch(`${origin}/api/runs/export_http/bundle`, {
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/gzip");
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("transfer-encoding"), "chunked");
    assert.match(
      response.headers.get("x-solaris-snapshot") ?? "",
      /^[a-f0-9]{64}$/,
    );
    const archive = Buffer.from(await response.arrayBuffer());
    assert.ok(archive.length > 4.5 * 1024 * 1024);
    const extracted = path.join(root, "extracted");
    await mkdir(extracted);
    const archivePath = path.join(root, "download.tar.gz");
    await writeFile(archivePath, archive);
    execFileSync("tar", ["-xzf", archivePath, "-C", extracted]);
    execFileSync("shasum", ["-a", "256", "-c", "checksums.sha256"], {
      cwd: extracted,
    });
    for (const name of ["001.jpg", "002.jpg", "final.jpg"])
      assert.deepEqual(
        await readFile(path.join(extracted, "evidence/T01/1", name)),
        await readFile(path.join(directory, name)),
      );
    await writeFile(
      path.join(root, "results/export_http/results.json"),
      JSON.stringify({ ...manifest, status: "running" }),
    );
    assert.equal(
      (await fetch(`${origin}/api/runs/export_http/bundle`)).status,
      409,
    );
    console.log(
      `Evidence export HTTP checks passed: ${archive.length} bytes streamed, all extracted checksums verified, origin guard and active-run rejection verified.`,
    );
  } finally {
    server.kill("SIGTERM");
    await Promise.race([
      closed,
      delay(5000).then(() => {
        server.kill("SIGKILL");
      }),
    ]);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
