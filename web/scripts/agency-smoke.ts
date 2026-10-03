/** Manual remote acceptance: creates one diagnostic job and one client project; never prints credentials. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runEvaluation } from "../../scripts/solaris-ci.mjs";

async function main() {
  const origin = process.env.GAUNTLET_PUBLIC_ORIGIN;
  const key = process.env.GAUNTLET_ADMIN_KEY;
  if (!origin || !key)
    throw new Error("Set the workspace origin and owner key privately.");
  let cookie = "";
  const created: string[] = [];
  async function owner(
    url: string,
    input?: unknown,
    expected = 200,
    method?: string,
  ) {
    const response = await fetch(origin + url, {
      method: method ?? (input === undefined ? "GET" : "POST"),
      headers: { origin: origin!, "Content-Type": "application/json", cookie },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      redirect: "error",
      signal: AbortSignal.timeout(240000),
    });
    assert.equal(response.status, expected, `${url}: HTTP ${response.status}`);
    if (response.headers.has("set-cookie"))
      cookie = response.headers.get("set-cookie")!.split(";")[0];
    return response.json();
  }
  async function machine(
    url: string,
    token: string,
    input?: unknown,
    expected = 200,
    launchKey?: string,
  ) {
    const response = await fetch(origin + "/api/automation/v1" + url, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(launchKey ? { "Idempotency-Key": launchKey } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      redirect: "error",
      signal: AbortSignal.timeout(240000),
    });
    assert.equal(response.status, expected, `${url}: HTTP ${response.status}`);
    return response.json();
  }
  const directory = await mkdtemp(path.join(tmpdir(), "solaris-agency-"));
  try {
    await owner("/api/integrations/tokens", undefined, 401);
    await owner("/api/session", { key });
    await machine("/runs", "invalid", undefined, 401);
    const reader = await owner(
      "/api/integrations/tokens",
      {
        name: "Acceptance read-only (temporary)",
        scopes: ["read"],
        expiresInDays: 1,
      },
      201,
    );
    created.push(reader.token.id);
    await machine("/runs", reader.secret);
    const setup = {
      tasks: ["T01", "T02"],
      trials: 1,
      concurrency: 1,
      maxInfraFailures: 1,
      provider: "claude",
      modelId: "",
    };
    const input = { setup, mode: "dry-run" };
    const launchKey = `acceptance-${randomUUID()}`;
    await machine("/jobs", reader.secret, input, 403, launchKey);
    const runner = await owner(
      "/api/integrations/tokens",
      {
        name: "Acceptance diagnostics (temporary)",
        scopes: ["read", "execute", "assess"],
        expiresInDays: 1,
      },
      201,
    );
    created.push(runner.token.id);
    await machine(
      "/jobs",
      runner.secret,
      { ...input, mode: "live" },
      403,
      launchKey,
    );
    const job = await machine("/jobs", runner.secret, input, 202, launchKey);
    console.log("Accepted diagnostic job", job.id);
    const replay = await machine("/jobs", runner.secret, input, 202, launchKey);
    assert.equal(replay.id, job.id);
    await machine(
      "/jobs",
      runner.secret,
      { ...input, setup: { ...setup, trials: 2 } },
      409,
      launchKey,
    );
    const evaluation = await runEvaluation({
      url: origin,
      token: runner.secret,
      setup,
      mode: "dry-run",
      idempotencyKey: launchKey,
      policy: {
        schema_version: 1,
        require_live: false,
        min_pass_rate: 0,
        max_total_cost_usd: 0,
      },
    });
    assert.equal(evaluation.jobId, job.id);
    assert.equal(evaluation.exitCode, 0);
    const run = await machine(`/runs/${job.id}`, runner.secret);
    assert.equal(run.records.length, 2);
    const listed = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = `/runs?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await machine(query, reader.secret);
      assert.equal(page.page.limit, 2);
      assert.ok(page.page.scanned <= 2);
      for (const card of page.runs) {
        listed.add(card.id);
        if (card.id === job.id) assert.equal(card.recorded, run.records.length);
      }
      cursor = page.page.nextCursor;
      if (cursor) {
        assert.ok(!cursors.has(cursor), "Continuation cursor repeated.");
        cursors.add(cursor);
      }
      assert.ok(++pages <= 100, "Acceptance archive exceeded its scan bound.");
    } while (cursor);
    assert.ok(
      listed.has(job.id),
      "The new evaluation is missing from the paged archive.",
    );
    const ownerPage = await owner("/api/runs?limit=1");
    assert.equal(ownerPage.page.limit, 1);
    await owner("/api/runs?limit=201", undefined, 400);
    console.log(
      `Cloud archive traversed safely: ${pages} pages, ${listed.size} evaluations.`,
    );
    const jobs = await owner("/api/jobs");
    const savedJob = jobs.jobs.find((value: any) => value.id === job.id);
    assert.equal(savedJob.status, "complete");
    if (process.env.GAUNTLET_EXPECTED_REVISION)
      assert.equal(
        savedJob.sourceRevision,
        process.env.GAUNTLET_EXPECTED_REVISION,
      );
    const project = await owner("/api/projects", {
      revision: 0,
      name: "Agency release acceptance",
      client: "Solaris internal validation",
      runIds: [job.id],
      status: "review",
      notes: "Internal delivery validation. Diagnostic evidence only.",
    });
    assert.equal(project.revision, 1);
    assert.ok(
      (await owner("/api/projects")).some(
        (value: any) => value.id === project.id,
      ),
    );
    const update = {
      id: project.id,
      revision: 1,
      name: project.name,
      client: project.client,
      runIds: [job.id],
    };
    // Older request bodies must preserve delivery fields they do not know about.
    const legacyUpdate = await owner("/api/projects", update);
    assert.equal(legacyUpdate.revision, 2);
    assert.equal(legacyUpdate.status, "review");
    assert.equal(legacyUpdate.notes, project.notes);
    await owner("/api/projects", update, 409);
    const archived = await owner("/api/projects", {
      ...update,
      revision: 2,
      status: "archived",
    });
    assert.equal(archived.status, "archived");
    const restored = await owner("/api/projects", {
      ...update,
      revision: 3,
      status: "review",
    });
    assert.equal(restored.revision, 4);
    assert.equal(restored.notes, project.notes);
    assert.deepEqual(restored.runIds, [job.id]);
    const bundle = await fetch(`${origin}/api/runs/${job.id}/bundle`, {
      headers: { cookie },
      redirect: "error",
      signal: AbortSignal.timeout(240000),
    });
    assert.equal(bundle.status, 200);
    const archive = path.join(directory, "evidence.tar.gz");
    await writeFile(archive, Buffer.from(await bundle.arrayBuffer()));
    execFileSync("tar", ["-xzf", archive, "-C", directory]);
    execFileSync("shasum", ["-a", "256", "-c", "checksums.sha256"], {
      cwd: directory,
      stdio: "pipe",
    });
    await readFile(path.join(directory, "evidence/T01/1/baseline.json"));
    assert.match(
      await readFile(path.join(directory, "HANDOFF.md"), "utf8"),
      /diagnostic|dry.run/i,
    );
    const foreign = await fetch(`${origin}/api/automation/v1/runs`, {
      headers: {
        Authorization: `Bearer ${reader.secret}`,
        origin: "https://invalid.example",
      },
    });
    assert.equal(foreign.status, 403);
    console.log(
      "Scoped access, duplicate protection, Python quality gate, client project persistence/conflict and evidence bundle checksums verified.",
    );
    console.log(
      JSON.stringify({
        jobId: job.id,
        projectId: project.id,
        sourceRevision: savedJob.sourceRevision,
      }),
    );
    for (const token of [reader, runner]) {
      await owner(
        "/api/integrations/tokens",
        { id: token.token.id },
        200,
        "DELETE",
      );
      created.splice(created.indexOf(token.token.id), 1);
      await machine("/runs", token.secret, undefined, 401);
    }
    console.log("Temporary credentials revoked and rejected by the API.");
  } finally {
    const revocations = await Promise.allSettled(
      created.map((id) =>
        owner("/api/integrations/tokens", { id }, 200, "DELETE"),
      ),
    );
    await rm(directory, { recursive: true, force: true });
    const unresolved = created.filter(
      (_, index) => revocations[index].status === "rejected",
    );
    if (unresolved.length)
      throw new Error(
        `Acceptance cleanup could not confirm revocation for token IDs: ${unresolved.join(", ")}. Revoke them in Integrations.`,
      );
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
