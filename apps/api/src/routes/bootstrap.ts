import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import { countUsers } from "../db/instance";

export interface BootstrapDeps {
  db: Database;
}

/** Public: the web /setup flow polls this to decide whether to show setup. */
export function bootstrapRoutes(deps: BootstrapDeps) {
  return new Elysia().get(
    "/api/bootstrap",
    () => ({
      needsSetup: countUsers(deps.db) === 0,
    }),
    {
      detail: {
        summary: "First-run state",
        description:
          "Whether the instance still needs its first account. `needsSetup` " +
          "is true only while zero users exist; the first signup claims " +
          "instance ownership and closes self-signup, flipping this to " +
          "false permanently. The web UI polls this to route between /setup " +
          "and /login. Public — no authentication.",
        tags: ["Bootstrap"],
        security: [],
      },
      response: {
        200: t.Object({ needsSetup: t.Boolean() }),
      },
    },
  );
}
