import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { type Auth, parseInstanceRole, principalPlugin } from "../auth";

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
    { requireAuth: true },
  );
}
