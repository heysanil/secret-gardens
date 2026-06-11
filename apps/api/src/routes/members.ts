import type { Database } from "bun:sqlite";
import type { ProjectRole } from "@secret-gardens/shared";
import { Elysia, t } from "elysia";
import { type Auth, principalPlugin } from "../auth";
import { newId } from "../db";
import type { AuditLog } from "../redis/audit";
import { ERROR_401, ERROR_403, ERROR_404 } from "./errorSchemas";

export interface MembersDeps {
  db: Database;
  auth: Auth;
  audit: AuditLog;
}

const ROLE_SCHEMA = t.Union([
  t.Literal("admin"),
  t.Literal("write"),
  t.Literal("read"),
]);

const MEMBER_SCHEMA = t.Object({
  userId: t.String(),
  name: t.String(),
  email: t.String(),
  role: ROLE_SCHEMA,
  createdAt: t.Number(),
});

interface MemberRow {
  user_id: string;
  role: ProjectRole;
  created_at: number;
  name: string;
  email: string;
}

interface MembershipRow {
  id: string;
  role: ProjectRole;
}

/**
 * Project membership management. LAST-ADMIN protection considers only the
 * membership table: instance owners/admins have implicit project-admin
 * access but do not count — every project must keep at least one explicit
 * admin membership.
 */
export function membersRoutes(deps: MembersDeps) {
  const { db, audit } = deps;

  function findMembership(
    projectId: string,
    userId: string,
  ): MembershipRow | null {
    return db
      .query<MembershipRow, [string, string]>(
        "SELECT id, role FROM project_memberships WHERE project_id = ? AND user_id = ?",
      )
      .get(projectId, userId);
  }

  function adminCount(projectId: string): number {
    return (
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM project_memberships WHERE project_id = ? AND role = 'admin'",
        )
        .get(projectId)?.n ?? 0
    );
  }

  return new Elysia({ prefix: "/api/projects/:projectId/members" })
    .use(principalPlugin(deps))
    .get(
      "/",
      ({ project }) => {
        const rows = db
          .query<MemberRow, [string]>(
            `SELECT m.user_id, m.role, m.created_at, u.name, u.email
             FROM project_memberships m
             JOIN "user" u ON u.id = m.user_id
             WHERE m.project_id = ?
             ORDER BY m.created_at, m.user_id`,
          )
          .all(project.id);
        return rows.map((row) => ({
          userId: row.user_id,
          name: row.name,
          email: row.email,
          role: row.role,
          createdAt: row.created_at,
        }));
      },
      {
        requireProject: "read",
        detail: {
          summary: "List project members",
          description:
            "Explicit memberships only — instance owners/admins with " +
            "implicit access do not appear unless they have joined. Any " +
            "project role may read the list; service tokens get 403/404.",
          tags: ["Members"],
        },
        response: {
          200: t.Array(MEMBER_SCHEMA),
          401: ERROR_401,
          403: ERROR_403,
          404: ERROR_404,
        },
      },
    )
    .post(
      "/",
      async ({ project, principal, body, set, status }) => {
        const user = db
          .query<{ id: string; name: string; email: string }, [string]>(
            'SELECT id, name, email FROM "user" WHERE id = ?',
          )
          .get(body.userId);
        if (user === null) {
          return status(404, { error: "not_found" });
        }
        if (findMembership(project.id, body.userId) !== null) {
          return status(409, { error: "already_member" });
        }
        const now = Date.now();
        db.run(
          `INSERT INTO project_memberships (id, project_id, user_id, role, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [newId("mem"), project.id, body.userId, body.role, now],
        );
        await audit.appendAudit(
          { projectId: project.id },
          {
            action: "member.add",
            actorType: "user",
            actorId: principal.userId,
            fields: { userId: body.userId, role: body.role },
          },
        );
        set.status = 201;
        return {
          userId: user.id,
          name: user.name,
          email: user.email,
          role: body.role,
          createdAt: now,
        };
      },
      {
        requireProject: "admin",
        body: t.Object({
          userId: t.String({ minLength: 1 }),
          role: ROLE_SCHEMA,
        }),
        detail: {
          summary: "Add a project member",
          description:
            "Grants an existing instance user a project role " +
            "(`admin`/`write`/`read`). 404 when the user id does not " +
            "exist; 409 `already_member` when they already have a role " +
            "(use PATCH to change it). Appends a `member.add` audit " +
            "entry. Project admins only; user principals only.",
          tags: ["Members"],
        },
        response: {
          201: MEMBER_SCHEMA,
          401: ERROR_401,
          403: ERROR_403,
          404: ERROR_404,
          409: t.Object({ error: t.Literal("already_member") }),
        },
      },
    )
    .patch(
      "/:userId",
      async ({ project, principal, params, body, status }) => {
        const membership = findMembership(project.id, params.userId);
        if (membership === null) {
          return status(404, { error: "not_found" });
        }
        if (
          membership.role === "admin" &&
          body.role !== "admin" &&
          adminCount(project.id) === 1
        ) {
          return status(409, { error: "last_admin" });
        }
        db.run("UPDATE project_memberships SET role = ? WHERE id = ?", [
          body.role,
          membership.id,
        ]);
        await audit.appendAudit(
          { projectId: project.id },
          {
            action: "member.update",
            actorType: "user",
            actorId: principal.userId,
            fields: { userId: params.userId, role: body.role },
          },
        );
        return { userId: params.userId, role: body.role };
      },
      {
        requireProject: "admin",
        body: t.Object({ role: ROLE_SCHEMA }),
        detail: {
          summary: "Change a member's role",
          description:
            "Reassigns a member's project role. Demoting the **last " +
            "explicit admin** is refused with 409 `last_admin` — implicit " +
            "instance-admin access does not count; every project must " +
            "keep one explicit admin membership. Appends a " +
            "`member.update` audit entry. Project admins only; user " +
            "principals only.",
          tags: ["Members"],
        },
        response: {
          200: t.Object({ userId: t.String(), role: ROLE_SCHEMA }),
          401: ERROR_401,
          403: ERROR_403,
          404: ERROR_404,
          409: t.Object({ error: t.Literal("last_admin") }),
        },
      },
    )
    .delete(
      "/:userId",
      async ({ project, principal, params, status }) => {
        const membership = findMembership(project.id, params.userId);
        if (membership === null) {
          return status(404, { error: "not_found" });
        }
        if (membership.role === "admin" && adminCount(project.id) === 1) {
          return status(409, { error: "last_admin" });
        }
        db.run("DELETE FROM project_memberships WHERE id = ?", [membership.id]);
        await audit.appendAudit(
          { projectId: project.id },
          {
            action: "member.remove",
            actorType: "user",
            actorId: principal.userId,
            fields: { userId: params.userId },
          },
        );
        return { removed: true };
      },
      {
        requireProject: "admin",
        detail: {
          summary: "Remove a project member",
          description:
            "Revokes a user's membership. Removing the **last explicit " +
            "admin** is refused with 409 `last_admin`. Appends a " +
            "`member.remove` audit entry. Project admins only; user " +
            "principals only.",
          tags: ["Members"],
        },
        response: {
          200: t.Object({ removed: t.Boolean() }),
          401: ERROR_401,
          403: ERROR_403,
          404: ERROR_404,
          409: t.Object({ error: t.Literal("last_admin") }),
        },
      },
    );
}
