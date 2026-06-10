import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, signUp } from "../../test/testApp";
import { TEST_REDIS_URL } from "../../test/testRedis";
import { createRedis } from "../redis/client";

const redis = createRedis(TEST_REDIS_URL);

beforeAll(async () => {
  await redis.connect();
});

afterAll(() => {
  redis.close();
});

describe("GET /api/bootstrap", () => {
  test("reports needsSetup true on a fresh database", async () => {
    const ctx = await createTestApp(redis);
    const res = await ctx.app.handle(
      new Request("http://localhost/api/bootstrap"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needsSetup: true });
    ctx.close();
  });

  test("reports needsSetup false after the first signup", async () => {
    const ctx = await createTestApp(redis);
    await signUp(ctx.app, {
      email: `boot-${crypto.randomUUID()}@test.dev`,
      password: "password123",
    });
    const res = await ctx.app.handle(
      new Request("http://localhost/api/bootstrap"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needsSetup: false });
    ctx.close();
  });
});
