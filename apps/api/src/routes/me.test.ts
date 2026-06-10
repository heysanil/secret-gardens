import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { TOKEN_PREFIXES } from "@safe/shared";
import { createTestApp, signUp, type TestApp } from "../../test/testApp";
import { TEST_REDIS_URL } from "../../test/testRedis";
import { createRedis } from "../redis/client";

const redis = createRedis(TEST_REDIS_URL);

beforeAll(async () => {
  await redis.connect();
});

afterAll(() => {
  redis.close();
});

const PAT_RE = /^safe_ut_[A-Za-z0-9_-]{43}$/;

function uniqueEmail(tag: string): string {
  return `${tag}-${crypto.randomUUID()}@test.dev`;
}

async function setupOwner(
  ctx: TestApp,
): Promise<{ cookie: string; email: string; userId: string }> {
  const email = uniqueEmail("owner");
  const { cookie } = await signUp(ctx.app, { email, password: "password123" });
  const row = ctx.db
    .query<{ id: string }, [string]>('SELECT id FROM "user" WHERE email = ?')
    .get(email);
  if (!row) throw new Error("owner not created");
  return { cookie, email, userId: row.id };
}

function get(ctx: TestApp, path: string, headers: Record<string, string> = {}) {
  return ctx.app.handle(new Request(`http://localhost${path}`, { headers }));
}

function createToken(
  ctx: TestApp,
  cookie: string,
  body: Record<string, unknown>,
) {
  return ctx.app.handle(
    new Request("http://localhost/api/me/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
}

function deleteToken(ctx: TestApp, cookie: string, id: string) {
  return ctx.app.handle(
    new Request(`http://localhost/api/me/tokens/${id}`, {
      method: "DELETE",
      headers: { cookie },
    }),
  );
}

describe("GET /api/me", () => {
  test("returns 401 without credentials", async () => {
    const ctx = await createTestApp(redis);
    const res = await get(ctx, "/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    ctx.close();
  });

  test("returns identity for a cookie session", async () => {
    const ctx = await createTestApp(redis);
    const { cookie, email, userId } = await setupOwner(ctx);
    const res = await get(ctx, "/api/me", { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      type: "user",
      userId,
      email,
      name: "Test User",
      instanceRole: "owner",
    });
    ctx.close();
  });
});

describe("personal access tokens", () => {
  test("create returns the token exactly once with prefix and metadata", async () => {
    const ctx = await createTestApp(redis);
    const { cookie } = await setupOwner(ctx);
    const res = await createToken(ctx, cookie, { name: "cli token" });
    expect(res.status).toBe(201);
    const text = await res.text();
    const body = JSON.parse(text) as {
      id: string;
      name: string;
      token: string;
      tokenPrefix: string;
      expiresAt: number | null;
    };
    expect(body.token).toMatch(PAT_RE);
    expect(body.tokenPrefix).toBe(body.token.slice(0, 12));
    expect(body.name).toBe("cli token");
    expect(body.expiresAt).toBeNull();
    // The plaintext appears exactly once in the response payload.
    expect(text.split(body.token).length - 1).toBe(1);
    // Only the sha256 hash is stored.
    const stored = ctx.db
      .query<{ token_hash: string }, [string]>(
        "SELECT token_hash FROM user_tokens WHERE id = ?",
      )
      .get(body.id);
    expect(stored?.token_hash).toBe(
      createHash("sha256").update(body.token).digest("hex"),
    );
    ctx.close();
  });

  test("create computes expiresAt from expiresInDays", async () => {
    const ctx = await createTestApp(redis);
    const { cookie } = await setupOwner(ctx);
    const before = Date.now();
    const res = await createToken(ctx, cookie, {
      name: "t",
      expiresInDays: 30,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { expiresAt: number };
    const thirtyDays = 30 * 86_400_000;
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + thirtyDays);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + thirtyDays);
    ctx.close();
  });

  test("create writes a token.create audit entry", async () => {
    const ctx = await createTestApp(redis);
    const { cookie, userId } = await setupOwner(ctx);
    const res = await createToken(ctx, cookie, { name: "audited token" });
    const body = (await res.json()) as { id: string };
    const page = await ctx.audit.readAudit("instance", { limit: 200 });
    const entry = page.entries.find(
      (e) => e.action === "token.create" && e.tokenId === body.id,
    );
    expect(entry).toBeDefined();
    expect(entry?.actorId).toBe(userId);
    expect(entry?.tokenType).toBe("user");
    expect(entry?.name).toBe("audited token");
    ctx.close();
  });

  for (const [label, body] of [
    ["empty name", { name: "" }],
    ["name too long", { name: "x".repeat(101) }],
    ["missing name", {}],
    ["zero expiresInDays", { name: "t", expiresInDays: 0 }],
    ["negative expiresInDays", { name: "t", expiresInDays: -1 }],
    ["expiresInDays above 365", { name: "t", expiresInDays: 366 }],
    ["fractional expiresInDays", { name: "t", expiresInDays: 1.5 }],
  ] as const) {
    test(`create rejects ${label} with 422`, async () => {
      const ctx = await createTestApp(redis);
      const { cookie } = await setupOwner(ctx);
      const res = await createToken(ctx, cookie, body);
      expect(res.status).toBe(422);
      ctx.close();
    });
  }

  test("list shows metadata but never hashes or plaintext", async () => {
    const ctx = await createTestApp(redis);
    const { cookie } = await setupOwner(ctx);
    const created = (await (
      await createToken(ctx, cookie, { name: "listed token" })
    ).json()) as { id: string; token: string };

    const res = await get(ctx, "/api/me/tokens", { cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    const list = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: created.id,
      name: "listed token",
      tokenPrefix: created.token.slice(0, 12),
      createdAt: expect.any(Number),
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(text).not.toContain(created.token);
    expect(text).not.toContain(
      createHash("sha256").update(created.token).digest("hex"),
    );
    ctx.close();
  });

  test("Bearer PAT authenticates /api/me and sets last_used_at", async () => {
    const ctx = await createTestApp(redis);
    const { cookie, userId } = await setupOwner(ctx);
    const created = (await (
      await createToken(ctx, cookie, { name: "bearer token" })
    ).json()) as { id: string; token: string };

    const res = await get(ctx, "/api/me", {
      authorization: `Bearer ${created.token}`,
    });
    expect(res.status).toBe(200);
    const me = (await res.json()) as { userId: string; instanceRole: string };
    expect(me.userId).toBe(userId);
    expect(me.instanceRole).toBe("owner");

    const list = (await (
      await get(ctx, "/api/me/tokens", { cookie })
    ).json()) as Array<{ id: string; lastUsedAt: number | null }>;
    expect(list.find((t) => t.id === created.id)?.lastUsedAt).not.toBeNull();
    ctx.close();
  });

  test("a PAT can manage tokens (CLI logout revokes itself)", async () => {
    const ctx = await createTestApp(redis);
    const { cookie } = await setupOwner(ctx);
    const created = (await (
      await createToken(ctx, cookie, { name: "self-managed" })
    ).json()) as { id: string; token: string };

    // List via Bearer.
    const listRes = await get(ctx, "/api/me/tokens", {
      authorization: `Bearer ${created.token}`,
    });
    expect(listRes.status).toBe(200);

    // Revoke itself via Bearer.
    const revokeRes = await ctx.app.handle(
      new Request(`http://localhost/api/me/tokens/${created.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${created.token}` },
      }),
    );
    expect(revokeRes.status).toBe(200);

    // The token no longer authenticates.
    const after = await get(ctx, "/api/me", {
      authorization: `Bearer ${created.token}`,
    });
    expect(after.status).toBe(401);
    ctx.close();
  });

  test("revoke is idempotent, audited, and scoped to the owner", async () => {
    const ctx = await createTestApp(redis);
    const { cookie, userId } = await setupOwner(ctx);
    const created = (await (
      await createToken(ctx, cookie, { name: "to revoke" })
    ).json()) as { id: string; token: string };

    const first = await deleteToken(ctx, cookie, created.id);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ revoked: true });

    // Revoked Bearer no longer works.
    const bearer = await get(ctx, "/api/me", {
      authorization: `Bearer ${created.token}`,
    });
    expect(bearer.status).toBe(401);
    expect(await bearer.json()).toEqual({ error: "invalid_token" });

    // Idempotent second delete.
    const second = await deleteToken(ctx, cookie, created.id);
    expect(second.status).toBe(200);

    // Nonexistent id → 404.
    const missing = await deleteToken(ctx, cookie, "ut_does_not_exist");
    expect(missing.status).toBe(404);

    // token.revoke audit entry exists exactly once (idempotent delete).
    const page = await ctx.audit.readAudit("instance", { limit: 200 });
    const entries = page.entries.filter(
      (e) => e.action === "token.revoke" && e.tokenId === created.id,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorId).toBe(userId);
    ctx.close();
  });

  test("cannot revoke another user's token (404)", async () => {
    const ctx = await createTestApp(redis);
    const { cookie: ownerCookie } = await setupOwner(ctx);
    const created = (await (
      await createToken(ctx, ownerCookie, { name: "owner token" })
    ).json()) as { id: string };

    // Second user via admin create-user, then sign in.
    const memberEmail = uniqueEmail("member");
    await ctx.app.handle(
      new Request("http://localhost/api/auth/admin/create-user", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({
          email: memberEmail,
          password: "memberpass123",
          name: "Member",
        }),
      }),
    );
    const signInRes = await ctx.app.handle(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: memberEmail, password: "memberpass123" }),
      }),
    );
    const memberCookie = signInRes.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const res = await deleteToken(ctx, memberCookie, created.id);
    expect(res.status).toBe(404);
    ctx.close();
  });

  test("expired PAT is rejected with 401", async () => {
    const ctx = await createTestApp(redis);
    const { cookie } = await setupOwner(ctx);
    const created = (await (
      await createToken(ctx, cookie, { name: "expiring", expiresInDays: 1 })
    ).json()) as { id: string; token: string };

    // Force the expiry into the past directly.
    ctx.db.run("UPDATE user_tokens SET expires_at = ? WHERE id = ?", [
      Date.now() - 1000,
      created.id,
    ]);
    const res = await get(ctx, "/api/me", {
      authorization: `Bearer ${created.token}`,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
    ctx.close();
  });

  test("garbage Bearer token → 401 invalid_token", async () => {
    const ctx = await createTestApp(redis);
    const res = await get(ctx, "/api/me", {
      authorization: "Bearer not-a-real-token",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
    ctx.close();
  });

  test("unknown service token → 401 invalid_token", async () => {
    const ctx = await createTestApp(redis);
    const res = await get(ctx, "/api/me", {
      authorization: `Bearer ${TOKEN_PREFIXES.serviceToken}sometoken`,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
    ctx.close();
  });
});

describe("PAT-minted token lifetime cap", () => {
  const DAY_MS = 86_400_000;

  function createdViaOf(ctx: TestApp, id: string): string | null {
    return (
      ctx.db
        .query<{ created_via: string }, [string]>(
          "SELECT created_via FROM user_tokens WHERE id = ?",
        )
        .get(id)?.created_via ?? null
    );
  }

  function createTokenViaBearer(
    ctx: TestApp,
    bearer: string,
    body: Record<string, unknown>,
  ) {
    return ctx.app.handle(
      new Request("http://localhost/api/me/tokens", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(body),
      }),
    );
  }

  test("session-created tokens stay uncapped with created_via 'session'", async () => {
    const ctx = await createTestApp(redis);
    const { cookie } = await setupOwner(ctx);
    const res = await createToken(ctx, cookie, { name: "unlimited" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; expiresAt: number | null };
    expect(body.expiresAt).toBeNull();
    expect(createdViaOf(ctx, body.id)).toBe("session");

    // The 365-day maximum still applies verbatim.
    const yearly = await createToken(ctx, cookie, {
      name: "year",
      expiresInDays: 365,
    });
    const yearlyBody = (await yearly.json()) as { expiresAt: number };
    expect(yearlyBody.expiresAt).toBeGreaterThan(Date.now() + 364 * DAY_MS);
    ctx.close();
  });

  test("PAT-created token with no expiry requested → 30-day cap applied", async () => {
    const ctx = await createTestApp(redis);
    const { cookie } = await setupOwner(ctx);
    const parent = (await (
      await createToken(ctx, cookie, { name: "immortal parent" })
    ).json()) as { token: string };

    const before = Date.now();
    const res = await createTokenViaBearer(ctx, parent.token, {
      name: "child",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; expiresAt: number };
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
    expect(createdViaOf(ctx, body.id)).toBe("token");

    // The response matches what was actually stored.
    const stored = ctx.db
      .query<{ expires_at: number | null }, [string]>(
        "SELECT expires_at FROM user_tokens WHERE id = ?",
      )
      .get(body.id);
    expect(stored?.expires_at).toBe(body.expiresAt);
    ctx.close();
  });

  test("PAT with 15 days left capping a 365-day request to its own expiry", async () => {
    const ctx = await createTestApp(redis);
    const { cookie } = await setupOwner(ctx);
    const parent = (await (
      await createToken(ctx, cookie, { name: "parent", expiresInDays: 30 })
    ).json()) as { id: string; token: string };
    // Shrink the parent's remaining lifetime to ~15 days.
    const parentExpiresAt = Date.now() + 15 * DAY_MS;
    ctx.db.run("UPDATE user_tokens SET expires_at = ? WHERE id = ?", [
      parentExpiresAt,
      parent.id,
    ]);

    const res = await createTokenViaBearer(ctx, parent.token, {
      name: "child",
      expiresInDays: 365,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; expiresAt: number };
    expect(body.expiresAt).toBe(parentExpiresAt);
    expect(createdViaOf(ctx, body.id)).toBe("token");
    ctx.close();
  });

  test("PAT-created request below the cap is honored as-is", async () => {
    const ctx = await createTestApp(redis);
    const { cookie } = await setupOwner(ctx);
    const parent = (await (
      await createToken(ctx, cookie, { name: "parent" })
    ).json()) as { token: string };

    const before = Date.now();
    const res = await createTokenViaBearer(ctx, parent.token, {
      name: "short child",
      expiresInDays: 7,
    });
    const body = (await res.json()) as { expiresAt: number };
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS);
    ctx.close();
  });
});
