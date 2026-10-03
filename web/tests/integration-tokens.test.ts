import test from "node:test";
import assert from "node:assert/strict";
import { createIntegrationTokens } from "../lib/integration-tokens";
import { StoreError } from "../lib/store";
function fixture() {
  let row: { value: unknown; etag: string } | null = null;
  let now = Date.parse("2026-10-02T00:00:00Z");
  let writes = 0;
  const store = {
    async readJSON<T>() {
      return row
        ? { value: structuredClone(row.value) as T, etag: row.etag }
        : null;
    },
    async writeJSON(_key: string, value: unknown, etag: string | null) {
      if ((row?.etag ?? null) !== etag) throw new StoreError("conflict", 409);
      row = { value: structuredClone(value), etag: String(++writes) };
      return { etag: row.etag };
    },
  };
  return {
    tokens: createIntegrationTokens(store, () => now),
    advance: () => {
      now += 31 * 86400000;
    },
    stored: () => JSON.stringify(row?.value),
    corrupt: () => {
      row = { value: { bad: true }, etag: "corrupt" };
    },
  };
}
const input = {
  name: "Agency CI",
  scopes: ["read", "execute", "assess"],
  expiresInDays: 30,
};
test("tokens are shown once, hashed at rest and never included in metadata", async () => {
  const f = fixture();
  const created = await f.tokens.create(input);
  assert.match(created.secret, /^solaris_[A-Za-z0-9_-]{43}$/);
  assert.equal(f.stored().includes(created.secret), false);
  assert.equal(JSON.stringify(await f.tokens.list()).includes("digest"), false);
  assert.equal(
    (await f.tokens.authenticate(created.secret, "execute")).id,
    created.token.id,
  );
  await assert.rejects(
    f.tokens.authenticate(created.secret, "live:execute"),
    (e) => e instanceof StoreError && e.status === 403,
  );
});
test("revocation is idempotent and expiry prevents access", async () => {
  const f = fixture();
  const first = await f.tokens.create(input);
  await f.tokens.revoke(first.token.id);
  const revoked = (await f.tokens.list())[0].revokedAt;
  await f.tokens.revoke(first.token.id);
  assert.equal((await f.tokens.list())[0].revokedAt, revoked);
  await assert.rejects(
    f.tokens.authenticate(first.secret, "read"),
    (e) => e instanceof StoreError && e.status === 401,
  );
  const second = await f.tokens.create(input);
  f.advance();
  await assert.rejects(
    f.tokens.authenticate(second.secret, "read"),
    (e) => e instanceof StoreError && e.status === 401,
  );
});
test("parallel credential changes retain both entries through conditional-write retries", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([
    f.tokens.create(input),
    f.tokens.create({ ...input, name: "n8n" }),
  ]);
  assert.equal((await f.tokens.list()).length, 2);
  await Promise.all([f.tokens.revoke(a.token.id), f.tokens.revoke(b.token.id)]);
  assert.ok((await f.tokens.list()).every((t) => t.revokedAt));
});
test("corrupt credential metadata fails closed and is never reset", async () => {
  const f = fixture();
  const saved = await f.tokens.create(input);
  f.corrupt();
  const before = f.stored();
  await assert.rejects(f.tokens.create(input), /unreadable/);
  await assert.rejects(
    f.tokens.authenticate(saved.secret, "read"),
    /unreadable/,
  );
  assert.equal(f.stored(), before);
});
test("invalid credential requests and oversized active collections fail explicitly", async () => {
  const f = fixture();
  for (const bad of [
    { ...input, name: " " },
    { ...input, scopes: [] },
    { ...input, scopes: ["admin"] },
    { ...input, expiresInDays: 91 },
    { ...input, extra: true },
  ])
    await assert.rejects(f.tokens.create(bad));
  await assert.rejects(f.tokens.authenticate("owner-key", "read"));
  for (let i = 0; i < 20; i++) await f.tokens.create(input);
  await assert.rejects(f.tokens.create(input), /limit/);
  assert.equal((await f.tokens.list()).length, 20);
});
