import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../lib/client";

test("unreadable successful responses reject instead of replacing saved client state", async (t) => {
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("<html>Upstream unavailable</html>", { status: 200 }),
  );
  let saved = ["retained evaluation"];
  await assert.rejects(
    api<string[]>("/api/runs").then((value) => {
      saved = value;
    }),
    /unreadable response/,
  );
  assert.deepEqual(saved, ["retained evaluation"]);
  assert.equal(fetch.mock.callCount(), 1);
});

test("JSON error responses preserve useful messages and handle malformed error shapes", async (t) => {
  for (const [payload, expected] of [
    [
      { error: "This project changed. Reload before saving." },
      /project changed/,
    ],
    [null, /Request failed/],
    [{ error: { secret: "must not become the message" } }, /Request failed/],
    [{ error: "  " }, /Request failed/],
  ] as const) {
    const fetch = t.mock.method(globalThis, "fetch", async () =>
      Response.json(payload, { status: 409 }),
    );
    await assert.rejects(api("/api/projects"), expected);
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});

test("a valid response returns once and keeps caller cancellation and no-store behavior", async (t) => {
  const abort = new AbortController();
  let sent: RequestInit | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      sent = options;
      return Response.json({ revision: 2 });
    },
  );
  assert.deepEqual(
    await api("/api/projects", {
      method: "POST",
      body: "{}",
      signal: abort.signal,
    }),
    { revision: 2 },
  );
  assert.equal(sent?.cache, "no-store");
  assert.equal(sent?.method, "POST");
  assert.equal(sent?.body, "{}");
  abort.abort();
  assert.equal(sent?.signal?.aborted, true);
});

test("body cancellation preserves its cause and never retries an ambiguous write", async (t) => {
  const abort = new AbortController();
  const reason = new DOMException("Cancelled by caller", "AbortError");
  const response = Response.json({ revision: 2 });
  t.mock.method(response, "json", async () => {
    abort.abort(reason);
    throw reason;
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(
    api("/api/projects", { method: "POST", body: "{}", signal: abort.signal }),
    (error) => error === reason,
  );
  assert.equal(fetch.mock.callCount(), 1);
});
