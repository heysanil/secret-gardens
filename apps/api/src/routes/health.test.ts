import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp } from "../../test/testApp";
import { TEST_REDIS_URL } from "../../test/testRedis";
import { createRedis, type RedisLike } from "../redis/client";

const redis = createRedis(TEST_REDIS_URL);

beforeAll(async () => {
  await redis.connect();
});

afterAll(() => {
  redis.close();
});

/** A RedisLike whose every call fails — exercises the unhealthy branch. */
const deadRedis: RedisLike = {
  connect: () => Promise.reject(new Error("connection refused")),
  close: () => {},
  send: () => Promise.reject(new Error("connection refused")),
  hget: () => Promise.reject(new Error("connection refused")),
  hgetall: () => Promise.reject(new Error("connection refused")),
  hkeys: () => Promise.reject(new Error("connection refused")),
};

describe("GET /api/health", () => {
  test("returns 200 with all checks ok when dependencies are healthy", async () => {
    const ctx = await createTestApp(redis);
    const res = await ctx.app.handle(
      new Request("http://localhost/api/health"),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      status: "ok",
      checks: {
        redis: "ok",
        database: "ok",
        kek: "ok",
      },
    });
    // The KEK fingerprint must never leak through this public endpoint.
    expect(text).not.toContain(ctx.config.masterKey.kekId);
    ctx.close();
  });

  test("returns 503 with redis marked failed when redis is unreachable", async () => {
    const ctx = await createTestApp(deadRedis);
    const res = await ctx.app.handle(
      new Request("http://localhost/api/health"),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, string>;
    };
    expect(body.status).toBe("error");
    expect(body.checks.redis).toBe("failed");
    expect(body.checks.database).toBe("ok");
    expect(body.checks.kek).toBe("ok");
    ctx.close();
  });

  test("returns 503 with database marked failed when sqlite is closed", async () => {
    const ctx = await createTestApp(redis);
    ctx.db.close();
    const res = await ctx.app.handle(
      new Request("http://localhost/api/health"),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, string>;
    };
    expect(body.checks.database).toBe("failed");
    expect(body.checks.redis).toBe("ok");
  });
});
