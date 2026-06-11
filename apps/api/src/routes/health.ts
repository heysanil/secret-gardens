import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
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

const CHECK_RESULT = t.Union([t.Literal("ok"), t.Literal("failed")]);
const CHECKS_SCHEMA = t.Object({
  redis: CHECK_RESULT,
  database: CHECK_RESULT,
  kek: CHECK_RESULT,
});

export function healthRoutes(deps: HealthDeps) {
  return new Elysia().get(
    "/api/health",
    async ({ set }) => {
      const checks: typeof CHECKS_SCHEMA.static = {
        redis: "ok",
        database: "ok",
        // Presence check only — never expose the KEK fingerprint on an
        // unauthenticated endpoint.
        kek: deps.config.masterKey.kekId !== "" ? "ok" : "failed",
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
    },
    {
      detail: {
        summary: "Health check",
        description:
          "Liveness plus dependency checks: Redis (PING, 2s timeout), " +
          "SQLite (SELECT 1), and master-key presence (presence only — the " +
          "KEK fingerprint is never exposed unauthenticated). Returns 503 " +
          "with the failing checks named when any dependency is down. " +
          "Suitable as a container health probe. Public — no authentication.",
        tags: ["Health"],
        security: [],
      },
      response: {
        200: t.Object({ status: t.Literal("ok"), checks: CHECKS_SCHEMA }),
        503: t.Object({ status: t.Literal("error"), checks: CHECKS_SCHEMA }),
      },
    },
  );
}
