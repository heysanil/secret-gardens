import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import type { Config } from "./config";
import type { RedisLike } from "./redis/client";
import { healthRoutes } from "./routes/health";

export interface AppDeps {
  db: Database;
  redis: RedisLike;
  config: Config;
}

/**
 * Composition root. Side-effect-free: no listening, no env reads — boot
 * wiring lives in index.ts so this stays importable for tests and for Eden
 * type extraction.
 */
export function createApp(deps: AppDeps) {
  return new Elysia().use(healthRoutes(deps));
}

export type App = ReturnType<typeof createApp>;
