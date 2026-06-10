import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { countUsers } from "../db/instance";

export interface BootstrapDeps {
  db: Database;
}

/** Public: the web /setup flow polls this to decide whether to show setup. */
export function bootstrapRoutes(deps: BootstrapDeps) {
  return new Elysia().get("/api/bootstrap", () => ({
    needsSetup: countUsers(deps.db) === 0,
  }));
}
