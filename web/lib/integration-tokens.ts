import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import * as storage from "./cloud-storage";
import { StoreError } from "./store";

export const INTEGRATION_SCOPES = [
  "read",
  "execute",
  "live:execute",
  "assess",
] as const;
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];
export const tokenInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z
      .array(z.enum(INTEGRATION_SCOPES))
      .min(1)
      .max(4)
      .refine((v) => new Set(v).size === v.length),
    expiresInDays: z.number().int().min(1).max(90).default(30),
  })
  .strict();
const tokenSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{24}$/),
    name: z.string().min(1).max(80),
    scopes: tokenInputSchema.shape.scopes,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    prefix: z.string().regex(/^solaris_[A-Za-z0-9_-]{8}$/),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
  })
  .strict();
const documentSchema = z
  .object({ version: z.literal(1), tokens: z.array(tokenSchema).max(200) })
  .strict()
  .refine(
    (doc) => new Set(doc.tokens.map((t) => t.id)).size === doc.tokens.length,
  );
export type IntegrationToken = Omit<z.infer<typeof tokenSchema>, "digest">;
const KEY = "workspace/integration-tokens.json";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function publicToken({
  digest: _digest,
  ...token
}: z.infer<typeof tokenSchema>): IntegrationToken {
  return token;
}

export function createIntegrationTokens(
  deps: Pick<typeof storage, "readJSON" | "writeJSON"> = storage,
  now = Date.now,
) {
  async function read() {
    const saved = await deps.readJSON<unknown>(KEY);
    const parsed = documentSchema.safeParse(
      saved ? saved.value : { version: 1, tokens: [] },
    );
    if (!parsed.success)
      throw new StoreError(
        "Integration credentials are unreadable. Existing credentials were not changed.",
        503,
      );
    return { value: parsed.data, etag: saved?.etag ?? null };
  }
  async function mutate(
    change: (value: z.infer<typeof documentSchema>) => void,
  ) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const saved = await read();
      change(saved.value);
      try {
        await deps.writeJSON(KEY, saved.value, saved.etag);
        return;
      } catch (error) {
        if (
          !(error instanceof StoreError) ||
          error.status !== 409 ||
          attempt === 3
        )
          throw error;
      }
    }
  }
  return {
    async list() {
      return (await read()).value.tokens
        .map(publicToken)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async create(raw: unknown) {
      const input = tokenInputSchema.parse(raw);
      const secret = `solaris_${randomBytes(32).toString("base64url")}`;
      const token = {
        id: randomBytes(12).toString("hex"),
        name: input.name,
        scopes: input.scopes,
        digest: hash(secret),
        prefix: secret.slice(0, 16),
        createdAt: new Date(now()).toISOString(),
        expiresAt: new Date(
          now() + input.expiresInDays * 86400000,
        ).toISOString(),
        revokedAt: null,
      };
      await mutate((doc) => {
        if (
          doc.tokens.filter(
            (t) => !t.revokedAt && Date.parse(t.expiresAt) > now(),
          ).length >= 20 ||
          doc.tokens.length >= 200
        )
          throw new StoreError(
            "Integration credential limit reached. Revoke unused active keys before creating another.",
            409,
          );
        doc.tokens.push(token);
      });
      return { token: publicToken(token), secret };
    },
    async revoke(id: string) {
      if (!/^[a-f0-9]{24}$/.test(id))
        throw new StoreError("Invalid integration credential.", 400);
      await mutate((doc) => {
        const token = doc.tokens.find((t) => t.id === id);
        if (!token)
          throw new StoreError("Integration credential not found.", 404);
        token.revokedAt ??= new Date(now()).toISOString();
      });
    },
    async authenticate(secret: string, scope: IntegrationScope) {
      if (!/^solaris_[A-Za-z0-9_-]{43}$/.test(secret))
        throw new StoreError("An active Solaris API token is required.", 401);
      const digest = Buffer.from(hash(secret), "hex");
      const token = (await read()).value.tokens.find((t) =>
        timingSafeEqual(digest, Buffer.from(t.digest, "hex")),
      );
      if (!token || token.revokedAt || Date.parse(token.expiresAt) <= now())
        throw new StoreError(
          "The Solaris API token is invalid, expired or revoked.",
          401,
        );
      if (!token.scopes.includes(scope))
        throw new StoreError(`This token does not grant ${scope} access.`, 403);
      return publicToken(token);
    },
  };
}
export const integrationTokens = createIntegrationTokens();
