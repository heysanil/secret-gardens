import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  adminCreateUser,
  createTestApp,
  signIn,
  signUp,
  type TestApp,
} from "../../test/testApp";
import { TEST_REDIS_URL } from "../../test/testRedis";
import { ALLOW_SIGNUP_KEY, getInstanceSetting } from "../db/instance";
import { createRedis } from "../redis/client";
import { claimInstanceOwnership, runAuthMigrations } from "./index";

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

function tableNames(ctx: TestApp): string[] {
  return ctx.db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

async function findAuditEntry(
  ctx: TestApp,
  predicate: (entry: Record<string, string | number>) => boolean,
): Promise<Record<string, string | number> | undefined> {
  const page = await ctx.audit.readAudit("instance", { limit: 200 });
  return page.entries.find(predicate);
}

describe("better-auth migrations", () => {
  test("boot creates better-auth tables alongside ours", async () => {
    const ctx = await createTestApp(redis);
    const tables = tableNames(ctx);
    // better-auth core schema
    for (const t of ["user", "session", "account", "verification"]) {
      expect(tables).toContain(t);
    }
    // ours, from src/db/migrations.ts
    for (const t of ["projects", "user_tokens", "instance_settings"]) {
      expect(tables).toContain(t);
    }
    ctx.close();
  });

  test("running better-auth migrations twice is idempotent", async () => {
    const ctx = await createTestApp(redis);
    const before = tableNames(ctx);
    await runAuthMigrations(ctx.auth);
    expect(tableNames(ctx)).toEqual(before);
    ctx.close();
  });
});

describe("signup flow", () => {
  test("first signup becomes owner, disables signup, and audits auth.login", async () => {
    const ctx = await createTestApp(redis);
    const email = uniqueEmail("first");
    const { res, cookie } = await signUp(ctx.app, {
      email,
      password: "password123",
    });
    expect(res.status).toBe(200);
    expect(cookie).not.toBe("");

    const user = ctx.db
      .query<{ id: string; role: string }, [string]>(
        'SELECT id, role FROM "user" WHERE email = ?',
      )
      .get(email);
    expect(user?.role).toBe("owner");
    expect(getInstanceSetting(ctx.db, ALLOW_SIGNUP_KEY)).toBe("false");

    // autoSignIn created a session → auth.login audit entry for this user.
    const entry = await findAuditEntry(
      ctx,
      (e) => e.action === "auth.login" && e.actorId === user?.id,
    );
    expect(entry).toBeDefined();
    expect(entry?.actorType).toBe("user");
    ctx.close();
  });

  test("concurrent first signups: exactly one user becomes owner", async () => {
    const ctx = await createTestApp(redis);
    // Simulate the race deterministically: both creates passed the signup
    // gate before either user.create.after hook ran, so two role-less users
    // exist when the hooks arbitrate ownership.
    const now = new Date().toISOString();
    for (const id of ["usr_race_one", "usr_race_two"]) {
      ctx.db.run(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role)
         VALUES (?, ?, ?, 0, ?, ?, 'member')`,
        [id, "Racer", uniqueEmail(id), now, now],
      );
    }

    expect(claimInstanceOwnership(ctx.db, "usr_race_one")).toBe(true);
    expect(claimInstanceOwnership(ctx.db, "usr_race_two")).toBe(false);

    const owners = ctx.db
      .query<{ id: string }, []>("SELECT id FROM \"user\" WHERE role = 'owner'")
      .all();
    expect(owners).toEqual([{ id: "usr_race_one" }]);
    const loser = ctx.db
      .query<{ role: string }, [string]>('SELECT role FROM "user" WHERE id = ?')
      .get("usr_race_two");
    expect(loser?.role).toBe("member");
    expect(getInstanceSetting(ctx.db, ALLOW_SIGNUP_KEY)).toBe("false");
    ctx.close();
  });

  test("second self-signup is rejected with signup_disabled", async () => {
    const ctx = await createTestApp(redis);
    await signUp(ctx.app, { email: uniqueEmail("a"), password: "password123" });
    const { res } = await signUp(ctx.app, {
      email: uniqueEmail("b"),
      password: "password123",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "signup_disabled" });
    ctx.close();
  });
});

describe("admin create-user", () => {
  test("owner creates a member who can sign in with a cookie session", async () => {
    const ctx = await createTestApp(redis);
    const { cookie: ownerCookie } = await signUp(ctx.app, {
      email: uniqueEmail("owner"),
      password: "password123",
    });

    const memberEmail = uniqueEmail("member");
    const created = await adminCreateUser(ctx.app, ownerCookie, {
      email: memberEmail,
      password: "memberpass123",
    });
    expect(created.status).toBe(200);

    const member = ctx.db
      .query<{ role: string }, [string]>(
        'SELECT role FROM "user" WHERE email = ?',
      )
      .get(memberEmail);
    expect(member?.role).toBe("member");

    // The created user signs in and the cookie round-trips through /api/me.
    const { res: signInRes, cookie } = await signIn(ctx.app, {
      email: memberEmail,
      password: "memberpass123",
    });
    expect(signInRes.status).toBe(200);
    const meRes = await ctx.app.handle(
      new Request("http://localhost/api/me", { headers: { cookie } }),
    );
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { email: string; instanceRole: string };
    expect(me.email).toBe(memberEmail);
    expect(me.instanceRole).toBe("member");
    ctx.close();
  });

  test("member cannot use the admin create-user endpoint", async () => {
    const ctx = await createTestApp(redis);
    const { cookie: ownerCookie } = await signUp(ctx.app, {
      email: uniqueEmail("owner"),
      password: "password123",
    });
    const memberEmail = uniqueEmail("member");
    await adminCreateUser(ctx.app, ownerCookie, {
      email: memberEmail,
      password: "memberpass123",
    });
    const { cookie: memberCookie } = await signIn(ctx.app, {
      email: memberEmail,
      password: "memberpass123",
    });
    const res = await adminCreateUser(ctx.app, memberCookie, {
      email: uniqueEmail("other"),
      password: "password123",
    });
    expect(res.status).toBe(403);
    ctx.close();
  });
});

describe("failed sign-in", () => {
  test("wrong password → 401 and an auth.failed_login audit entry", async () => {
    const ctx = await createTestApp(redis);
    const email = uniqueEmail("fail");
    await signUp(ctx.app, { email, password: "password123" });

    const { res } = await signIn(ctx.app, { email, password: "wrong-pass" });
    expect(res.status).toBe(401);

    const entry = await findAuditEntry(
      ctx,
      (e) => e.action === "auth.failed_login" && e.email === email,
    );
    expect(entry).toBeDefined();
    expect(entry?.ip).toBeDefined();
    ctx.close();
  });

  test("x-forwarded-for is recorded on failed sign-ins", async () => {
    const ctx = await createTestApp(redis);
    const email = uniqueEmail("xff");
    await signUp(ctx.app, { email, password: "password123" });

    const res = await ctx.app.handle(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.7, 10.0.0.1",
        },
        body: JSON.stringify({ email, password: "wrong-pass" }),
      }),
    );
    expect(res.status).toBe(401);

    const entry = await findAuditEntry(
      ctx,
      (e) => e.action === "auth.failed_login" && e.email === email,
    );
    expect(entry?.ip).toBe("203.0.113.7");
    ctx.close();
  });

  test("successful sign-in does not produce a failed_login entry", async () => {
    const ctx = await createTestApp(redis);
    const email = uniqueEmail("ok");
    await signUp(ctx.app, { email, password: "password123" });
    const { res } = await signIn(ctx.app, { email, password: "password123" });
    expect(res.status).toBe(200);
    const entry = await findAuditEntry(
      ctx,
      (e) => e.action === "auth.failed_login" && e.email === email,
    );
    expect(entry).toBeUndefined();
    ctx.close();
  });
});
