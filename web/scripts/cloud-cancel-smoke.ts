/** Creates one real diagnostic cloud job and verifies owner-requested cancellation. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

async function main() {
  const origin = process.env.GAUNTLET_PUBLIC_ORIGIN;
  const key = process.env.GAUNTLET_ADMIN_KEY;
  if (!origin || !key)
    throw new Error(
      "Set the private owner key and public origin before running.",
    );
  let cookie = "";
  async function request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: origin!,
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(240_000),
    });
    const data = await response.json();
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
    const session = response.headers.get("set-cookie");
    if (session) cookie = session.split(";")[0];
    return data;
  }
  await request(`/api/jobs/cloud_${"0".repeat(32)}/cancel`, {}, 401);
  await request("/api/session", { key });
  const job = await request(
    "/api/jobs",
    {
      mode: "dry-run",
      setup: {
        tasks: ["T01", "T02"],
        trials: 3,
        concurrency: 1,
        maxInfraFailures: 1,
        provider: "claude",
        modelId: "",
      },
    },
    202,
  );
  console.log("Created diagnostic job", job.id, "source", job.sourceRevision);
  assert.equal(job.controlVersion, 1);
  const stopped = await request(`/api/jobs/${job.id}/cancel`, {}, 202);
  assert.equal(
    stopped.status,
    "cancelling",
    "Evaluation finished before the cancellation check; inspect this job without replaying it.",
  );
  assert.equal("callbackToken" in stopped, false);
  const repeated = await request(`/api/jobs/${job.id}/cancel`, {}, 202);
  assert.equal(repeated.cancelRequestedAt, stopped.cancelRequestedAt);
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const { jobs } = await request("/api/jobs");
    const current = jobs.find((entry: { id: string }) => entry.id === job.id);
    if (
      current &&
      ["cancelled", "complete", "failed", "interrupted"].includes(
        current.status,
      )
    ) {
      assert.equal(current.status, "cancelled", JSON.stringify(current));
      console.log(
        JSON.stringify({
          id: current.id,
          status: current.status,
          exitCode: current.exitCode,
          cancelRequestedAt: current.cancelRequestedAt,
          note: current.error ?? null,
        }),
      );
      console.log(
        "Cancellation persisted and acknowledged. External desktop deletion was not exercised by this diagnostic.",
      );
      return;
    }
    await delay(3000);
  }
  throw new Error(
    `Cancellation was not acknowledged in time; inspect ${job.id}. No replay was attempted.`,
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
