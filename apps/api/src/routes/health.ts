import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import type { Config } from "../config";
import type { RedisLike } from "../redis/client";

export interface HealthDeps {
  db: Database;
  redis: RedisLike;
  config: Config;
}

const CHECK_TIMEOUT_MS = 2000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("health check timed out")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function healthRoutes(deps: HealthDeps) {
  return new Elysia().get("/api/health", async ({ set }) => {
    const kekId = deps.config.masterKey.kekId;
    const checks = {
      redis: "ok",
      database: "ok",
      kek: kekId !== "" ? kekId : "failed",
    };
    let healthy = checks.kek !== "failed";

    try {
      await withTimeout(deps.redis.send("PING", []), CHECK_TIMEOUT_MS);
    } catch {
      checks.redis = "failed";
      healthy = false;
    }

    try {
      deps.db.query("SELECT 1").get();
    } catch {
      checks.database = "failed";
      healthy = false;
    }

    if (!healthy) {
      set.status = 503;
      return { status: "error" as const, checks };
    }
    return { status: "ok" as const, checks };
  });
}
