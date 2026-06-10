import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateMasterKey } from "@safe/crypto";
import { TEST_REDIS_URL } from "../../test/testRedis";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { openDb, runMigrations } from "../db";
import { createRedis, type RedisLike } from "../redis/client";

const config = loadConfig({
  SAFE_MASTER_KEY: generateMasterKey(),
  REDIS_URL: TEST_REDIS_URL,
});

const redis = createRedis(TEST_REDIS_URL);

beforeAll(async () => {
  await redis.connect();
});

afterAll(() => {
  redis.close();
});

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

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
    const db = freshDb();
    const app = createApp({ db, redis, config });
    const res = await app.handle(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      checks: {
        redis: "ok",
        database: "ok",
        kek: config.masterKey.kekId,
      },
    });
    db.close();
  });

  test("returns 503 with redis marked failed when redis is unreachable", async () => {
    const db = freshDb();
    const app = createApp({ db, redis: deadRedis, config });
    const res = await app.handle(new Request("http://localhost/api/health"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, string>;
    };
    expect(body.status).toBe("error");
    expect(body.checks.redis).toBe("failed");
    expect(body.checks.database).toBe("ok");
    expect(body.checks.kek).toBe(config.masterKey.kekId);
    db.close();
  });

  test("returns 503 with database marked failed when sqlite is closed", async () => {
    const db = freshDb();
    db.close();
    const app = createApp({ db, redis, config });
    const res = await app.handle(new Request("http://localhost/api/health"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, string>;
    };
    expect(body.checks.database).toBe("failed");
    expect(body.checks.redis).toBe("ok");
  });
});
