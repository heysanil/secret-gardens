import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { TOKEN_PREFIXES } from "@safe/shared";
import { createTestApp, signUp, type TestApp } from "../../test/testApp";
import { TEST_REDIS_URL } from "../../test/testRedis";
import { newId } from "../db";
import { createRedis } from "../redis/client";
import { parseInstanceRole, resolvePrincipal } from "./principal";

const redis = createRedis(TEST_REDIS_URL);

beforeAll(async () => {
  await redis.connect();
});

afterAll(() => {
  redis.close();
});

function uniqueEmail(tag: string): string {
  return `${tag}-${crypto.randomUUID()}@test.dev`;
}

function bearerRequest(token: string): Request {
  return new Request("http://localhost/api/me", {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Inserts a PAT row directly; returns the plaintext token. */
function insertToken(
  ctx: TestApp,
  userId: string,
  overrides: { expiresAt?: number | null; revokedAt?: number | null } = {},
): string {
  const token =
    TOKEN_PREFIXES.userToken + randomBytes(32).toString("base64url");
  ctx.db.run(
    `INSERT INTO user_tokens (id, user_id, name, token_hash, token_prefix, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId("ut"),
      userId,
      "test token",
      createHash("sha256").update(token).digest("hex"),
      token.slice(0, 12),
      overrides.expiresAt ?? null,
      overrides.revokedAt ?? null,
      Date.now(),
    ],
  );
  return token;
}

function ownerUserId(ctx: TestApp): string {
  const row = ctx.db
    .query<{ id: string }, []>("SELECT id FROM \"user\" WHERE role = 'owner'")
    .get();
  if (!row) throw new Error("no owner user");
  return row.id;
}

describe("parseInstanceRole", () => {
  test("maps known roles and falls back to member", () => {
    expect(parseInstanceRole("owner")).toBe("owner");
    expect(parseInstanceRole("admin")).toBe("admin");
    expect(parseInstanceRole("member")).toBe("member");
    expect(parseInstanceRole(null)).toBe("member");
    expect(parseInstanceRole(undefined)).toBe("member");
    expect(parseInstanceRole("something-else")).toBe("member");
  });

  test("handles comma-separated role lists with owner > admin precedence", () => {
    expect(parseInstanceRole("member,owner")).toBe("owner");
    expect(parseInstanceRole("admin,member")).toBe("admin");
  });
});

describe("resolvePrincipal", () => {
  test("no credentials → null principal, no error", async () => {
    const ctx = await createTestApp(redis);
    const res = await resolvePrincipal(
      ctx,
      new Request("http://localhost/api/me"),
    );
    expect(res).toEqual({ principal: null, errorCode: null });
    ctx.close();
  });

  test("garbage Bearer token → invalid_token", async () => {
    const ctx = await createTestApp(redis);
    const res = await resolvePrincipal(ctx, bearerRequest("ghp_nonsense"));
    expect(res.principal).toBeNull();
    expect(res.errorCode).toBe("invalid_token");
    ctx.close();
  });

  test("service token prefix → service_tokens_not_enabled (Phase 6)", async () => {
    const ctx = await createTestApp(redis);
    const res = await resolvePrincipal(
      ctx,
      bearerRequest(`${TOKEN_PREFIXES.serviceToken}whatever`),
    );
    expect(res.principal).toBeNull();
    expect(res.errorCode).toBe("service_tokens_not_enabled");
    ctx.close();
  });

  test("valid PAT → user principal with instance role from the user table", async () => {
    const ctx = await createTestApp(redis);
    await signUp(ctx.app, {
      email: uniqueEmail("own"),
      password: "password123",
    });
    const userId = ownerUserId(ctx);
    const token = insertToken(ctx, userId);

    const res = await resolvePrincipal(ctx, bearerRequest(token));
    expect(res.errorCode).toBeNull();
    expect(res.principal).toEqual({
      type: "user",
      userId,
      instanceRole: "owner",
    });
    ctx.close();
  });

  test("PAT with an unknown user token hash → invalid_token", async () => {
    const ctx = await createTestApp(redis);
    const unknown =
      TOKEN_PREFIXES.userToken + randomBytes(32).toString("base64url");
    const res = await resolvePrincipal(ctx, bearerRequest(unknown));
    expect(res.errorCode).toBe("invalid_token");
    ctx.close();
  });

  test("revoked PAT → invalid_token", async () => {
    const ctx = await createTestApp(redis);
    await signUp(ctx.app, {
      email: uniqueEmail("rev"),
      password: "password123",
    });
    const token = insertToken(ctx, ownerUserId(ctx), {
      revokedAt: Date.now(),
    });
    const res = await resolvePrincipal(ctx, bearerRequest(token));
    expect(res.errorCode).toBe("invalid_token");
    ctx.close();
  });

  test("expired PAT → invalid_token", async () => {
    const ctx = await createTestApp(redis);
    await signUp(ctx.app, {
      email: uniqueEmail("exp"),
      password: "password123",
    });
    const token = insertToken(ctx, ownerUserId(ctx), {
      expiresAt: Date.now() - 1000,
    });
    const res = await resolvePrincipal(ctx, bearerRequest(token));
    expect(res.errorCode).toBe("invalid_token");
    ctx.close();
  });

  test("PAT use sets last_used_at, throttled to once per 60s", async () => {
    const ctx = await createTestApp(redis);
    await signUp(ctx.app, {
      email: uniqueEmail("lu"),
      password: "password123",
    });
    const token = insertToken(ctx, ownerUserId(ctx));
    const lastUsed = () =>
      ctx.db
        .query<{ last_used_at: number | null }, [string]>(
          "SELECT last_used_at FROM user_tokens WHERE token_hash = ?",
        )
        .get(createHash("sha256").update(token).digest("hex"))?.last_used_at ??
      null;

    expect(lastUsed()).toBeNull();
    await resolvePrincipal(ctx, bearerRequest(token));
    const first = lastUsed();
    expect(first).not.toBeNull();

    // A second use within the throttle window leaves last_used_at unchanged.
    await resolvePrincipal(ctx, bearerRequest(token));
    expect(lastUsed()).toBe(first);

    // Once the stored value is older than the window, it is refreshed.
    ctx.db.run("UPDATE user_tokens SET last_used_at = ? WHERE token_hash = ?", [
      Date.now() - 61_000,
      createHash("sha256").update(token).digest("hex"),
    ]);
    await resolvePrincipal(ctx, bearerRequest(token));
    expect(lastUsed()).toBeGreaterThan(Date.now() - 5_000);
    ctx.close();
  });

  test("cookie session → user principal", async () => {
    const ctx = await createTestApp(redis);
    const { cookie } = await signUp(ctx.app, {
      email: uniqueEmail("cook"),
      password: "password123",
    });
    const res = await resolvePrincipal(
      ctx,
      new Request("http://localhost/api/me", { headers: { cookie } }),
    );
    expect(res.errorCode).toBeNull();
    expect(res.principal).toEqual({
      type: "user",
      userId: ownerUserId(ctx),
      instanceRole: "owner",
    });
    ctx.close();
  });

  test("malformed Authorization header (non-Bearer) → invalid_token", async () => {
    const ctx = await createTestApp(redis);
    const res = await resolvePrincipal(
      ctx,
      new Request("http://localhost/api/me", {
        headers: { authorization: "Basic dXNlcjpwdw==" },
      }),
    );
    expect(res.errorCode).toBe("invalid_token");
    ctx.close();
  });
});
