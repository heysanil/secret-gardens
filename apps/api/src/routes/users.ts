import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import { type Auth, parseInstanceRole, principalPlugin } from "../auth";
import { ERROR_401, ERROR_403 } from "./errorSchemas";

export interface UsersDeps {
  db: Database;
  auth: Auth;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string | null;
  createdAt: string;
}

/**
 * Instance user directory (the member picker in the web UI). Any signed-in
 * user may list it: project admins who are not instance admins need it to
 * add members — acceptable exposure for a self-hosted team tool. Service
 * tokens are still rejected (requireAuth is user-only).
 */
export function usersRoutes(deps: UsersDeps) {
  return new Elysia().use(principalPlugin(deps)).get(
    "/api/users",
    () => {
      const rows = deps.db
        .query<UserRow, []>(
          'SELECT id, name, email, role, createdAt FROM "user" ORDER BY createdAt, id',
        )
        .all();
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: parseInstanceRole(row.role),
        createdAt: row.createdAt,
      }));
    },
    {
      requireAuth: true,
      detail: {
        summary: "List instance users",
        description:
          "The full user directory with instance roles — powers the " +
          "member picker in the web UI. Any signed-in user may list it " +
          "(project admins who are not instance admins need it to add " +
          "members); service tokens are rejected with 403.",
        tags: ["Users"],
      },
      response: {
        200: t.Array(
          t.Object({
            id: t.String(),
            name: t.String(),
            email: t.String(),
            role: t.Union([
              t.Literal("owner"),
              t.Literal("admin"),
              t.Literal("member"),
            ]),
            createdAt: t.String(),
          }),
        ),
        401: ERROR_401,
        403: ERROR_403,
      },
    },
  );
}
