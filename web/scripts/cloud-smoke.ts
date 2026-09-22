/** Explicit remote acceptance check: creates two real diagnostic runs and durable review/preset records. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
async function main() {
  const origin = process.env.GAUNTLET_PUBLIC_ORIGIN;
  const key = process.env.GAUNTLET_ADMIN_KEY;
  if (!origin || !key)
    throw new Error(
      "Set GAUNTLET_PUBLIC_ORIGIN and GAUNTLET_ADMIN_KEY privately before running.",
    );
  let cookie = "";
  async function request(url: string, input?: unknown, expected = 200) {
    const response = await fetch(origin + url, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        origin: origin!,
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(240_000),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${url}: ${text.slice(0, 1000)}`);
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return JSON.parse(text);
  }
  await request("/api/runs", undefined, 401);
  await request("/api/session", { key });
  assert.equal((await request("/api/session")).authenticated, true);
  console.log("Owner session and anonymous access protection verified.");
  const setup = {
    tasks: ["T01", "T02"],
    trials: 1,
    concurrency: 1,
    maxInfraFailures: 1,
    provider: "claude",
    modelId: "",
  };
  async function run(parentId?: string) {
    const job = await request(
      "/api/jobs",
      { setup, mode: "dry-run", ...(parentId ? { parentId } : {}) },
      202,
    );
    console.log("Started actual cloud job", job.id);
    assert.equal("callbackToken" in job, false);
    for (let attempt = 0; attempt < 60; attempt++) {
      const jobs = await request("/api/jobs");
      const current = jobs.jobs.find((value: any) => value.id === job.id);
      if (
        current &&
        ["complete", "failed", "interrupted"].includes(current.status)
      ) {
        assert.equal(current.status, "complete", JSON.stringify(current));
        const result = await request(`/api/runs/${job.id}`);
        assert.equal(result.records.length, 2);
        console.log("Cloud job completed with persisted evidence", job.id);
        return job.id as string;
      }
      await delay(3000);
    }
    throw new Error(
      `Job ${job.id} did not finish; inspect it before retrying.`,
    );
  }
  const first = await run();
  assert.equal((await request(`/api/runs/${first}/audit`)).healthy, true);
  const detail = await request(`/api/runs/${first}/trials/T01/1`);
  assert.equal(detail.trial.task_id, "T01");
  const second = await run(first);
  assert.equal(
    (await request(`/api/runs/${second}/attempts`)).parents.length,
    1,
  );
  const comparison = await request(
    `/api/compare?candidate=${second}&baseline=${first}`,
  );
  assert.equal(comparison.summary.transitions.inconclusive, 0);
  assert.equal(
    (
      await request(`/api/runs/${second}/gate`, {
        policy: { schema_version: 1 },
      })
    ).passed,
    false,
  );
  assert.equal(
    (
      await request(`/api/runs/${second}/gate`, {
        baseline: first,
        policy: {
          schema_version: 1,
          require_live: false,
          min_pass_rate: 0,
          max_regressions: 0,
          max_total_cost_usd: 0,
        },
      })
    ).passed,
    true,
  );
  console.log(
    "Audit, comparison, strict gate failure and diagnostic gate success verified.",
  );
  const reviewURL = `/api/runs/${first}/trials/T01/1/review`;
  const review = await request(reviewURL);
  const input = {
    revision: 0,
    evidenceDigest: review.evidenceDigest,
    verdict: "needs-investigation",
    category: "agent",
    reviewer: "Deployment verification",
    note: "Real cloud diagnostic execution verified. This is a dry run, not a live model benchmark.",
  };
  assert.equal((await request(reviewURL, input)).revision, 1);
  await request(reviewURL, input, 409);
  assert.equal((await request(reviewURL)).note, input.note);
  const preset = await request("/api/presets", {
    revision: 0,
    name: "Cloud diagnostic check",
    setup,
  });
  assert.equal(preset.revision, 1);
  assert.equal((await request(`/api/runs/${first}/export`)).mode, "dry-run");
  const foreign = await fetch(origin + "/api/presets", {
    method: "POST",
    headers: {
      origin: "https://invalid.example",
      "Content-Type": "application/json",
      cookie,
    },
    body: "{}",
  });
  assert.equal(foreign.status, 403);
  console.log(
    "Durable review, stale-write rejection, saved setup, export and cross-origin protection verified.",
  );
  console.log(JSON.stringify({ first, second }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
