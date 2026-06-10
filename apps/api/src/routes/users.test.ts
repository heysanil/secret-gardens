import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  adminCreateUser,
  api,
  createTestApp,
  signIn,
  signUp,
  signUpUser,
} from "../../test/testApp";
import { TEST_REDIS_URL } from "../../test/testRedis";
import { createRedis } from "../redis/client";

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

describe("GET /api/users", () => {
  test("requires authentication", async () => {
    const ctx = await createTestApp(redis);
    const res = await ctx.app.handle(new Request("http://localhost/api/users"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    ctx.close();
  });

  test("members can list the user directory", async () => {
    const ctx = await createTestApp(redis);
    const ownerEmail = uniqueEmail("owner");
    const { cookie: ownerCookie } = await signUp(ctx.app, {
      email: ownerEmail,
      password: "password123",
    });
    const memberEmail = uniqueEmail("member");
    await adminCreateUser(ctx.app, ownerCookie, {
      email: memberEmail,
      password: "memberpass123",
    });
    const { cookie } = await signIn(ctx.app, {
      email: memberEmail,
      password: "memberpass123",
    });
    const res = await ctx.app.handle(
      new Request("http://localhost/api/users", { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const users = (await res.json()) as Array<{ email: string }>;
    expect(users.map((u) => u.email).sort()).toEqual(
      [ownerEmail, memberEmail].sort(),
    );
    ctx.close();
  });

  test("service tokens are forbidden", async () => {
    const ctx = await createTestApp(redis);
    const owner = await signUpUser(ctx.app, "owner");
    const created = await api(ctx.app, "POST", "/api/projects", {
      cookie: owner.cookie,
      body: { name: "Directory Probe" },
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string };
    const minted = await api(
      ctx.app,
      "POST",
      `/api/projects/${project.id}/tokens`,
      {
        cookie: owner.cookie,
        body: { name: "ci", scope: "read_write" },
      },
    );
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };

    const res = await api(ctx.app, "GET", "/api/users", { bearer: token });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    ctx.close();
  });

  test("owner sees all users with roles", async () => {
    const ctx = await createTestApp(redis);
    const ownerEmail = uniqueEmail("owner");
    const { cookie } = await signUp(ctx.app, {
      email: ownerEmail,
      password: "password123",
    });
    const memberEmail = uniqueEmail("member");
    await adminCreateUser(ctx.app, cookie, {
      email: memberEmail,
      password: "memberpass123",
      name: "Member User",
    });

    const res = await ctx.app.handle(
      new Request("http://localhost/api/users", { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const users = (await res.json()) as Array<{
      id: string;
      name: string;
      email: string;
      role: string;
      createdAt: string;
    }>;
    expect(users).toHaveLength(2);
    const byEmail = new Map(users.map((u) => [u.email, u]));
    expect(byEmail.get(ownerEmail)?.role).toBe("owner");
    expect(byEmail.get(memberEmail)?.role).toBe("member");
    for (const user of users) {
      expect(user.id).toBeString();
      expect(user.name).toBeString();
      expect(user.createdAt).toBeString();
    }
    ctx.close();
  });
});
