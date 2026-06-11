import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import { type Auth, principalPlugin } from "../auth";
import { newId } from "../db";
import type { AuditLog } from "../redis/audit";
import type { SecretStore } from "../redis/secretStore";

export interface EnvironmentsDeps {
  db: Database;
  auth: Auth;
  audit: AuditLog;
  secretStore: SecretStore;
}

export const ENV_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

interface EnvironmentRow {
  id: string;
  name: string;
  slug: string;
  position: number;
}

/**
 * Environment CRUD — project admins only. Slugs are immutable after
 * creation: ciphertext AAD is id-based so renames would be safe
 * cryptographically, but slug stability keeps CLI configs (.gardens.json
 * defaultEnvironment) valid.
 */
export function environmentsRoutes(deps: EnvironmentsDeps) {
  const { db, audit, secretStore } = deps;

  function findEnv(projectId: string, envId: string): EnvironmentRow | null {
    return db
      .query<EnvironmentRow, [string, string]>(
        "SELECT id, name, slug, position FROM environments WHERE id = ? AND project_id = ?",
      )
      .get(envId, projectId);
  }

  return new Elysia({ prefix: "/api/projects/:projectId/environments" })
    .use(principalPlugin(deps))
    .post(
      "/",
      async ({ project, principal, body, set, status }) => {
        if (!ENV_SLUG_RE.test(body.slug)) {
          return status(422, { error: "invalid_slug" });
        }
        if (
          db
            .query(
              "SELECT id FROM environments WHERE project_id = ? AND slug = ?",
            )
            .get(project.id, body.slug) !== null
        ) {
          return status(409, { error: "duplicate_slug" });
        }
        const id = newId("env");
        const position =
          db
            .query<{ position: number }, [string]>(
              "SELECT COALESCE(MAX(position) + 1, 0) AS position FROM environments WHERE project_id = ?",
            )
            .get(project.id)?.position ?? 0;
        db.run(
          `INSERT INTO environments (id, project_id, name, slug, position, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, project.id, body.name, body.slug, position, Date.now()],
        );
        await audit.appendAudit(
          { projectId: project.id },
          {
            action: "env.create",
            actorType: "user",
            actorId: principal.userId,
            fields: { envId: id, slug: body.slug, name: body.name },
          },
        );
        set.status = 201;
        return { id, name: body.name, slug: body.slug, position };
      },
      {
        requireProject: "admin",
        body: t.Object({
          name: t.String({ minLength: 1, maxLength: 50 }),
          slug: t.String({ minLength: 1, maxLength: 32 }),
        }),
      },
    )
    .patch(
      "/:envId",
      async ({ project, principal, params, body, status }) => {
        const env = findEnv(project.id, params.envId);
        if (env === null) {
          return status(404, { error: "not_found" });
        }
        const changed: string[] = [];
        if (body.name !== undefined) changed.push("name");
        if (body.position !== undefined) changed.push("position");
        if (changed.length > 0) {
          db.run(
            "UPDATE environments SET name = ?, position = ? WHERE id = ?",
            [body.name ?? env.name, body.position ?? env.position, env.id],
          );
          await audit.appendAudit(
            { projectId: project.id },
            {
              action: "env.update",
              actorType: "user",
              actorId: principal.userId,
              fields: { envId: env.id, changed: changed.join(",") },
            },
          );
        }
        return {
          id: env.id,
          name: body.name ?? env.name,
          slug: env.slug,
          position: body.position ?? env.position,
        };
      },
      {
        requireProject: "admin",
        body: t.Object({
          name: t.Optional(t.String({ minLength: 1, maxLength: 50 })),
          position: t.Optional(t.Integer({ minimum: 0 })),
        }),
      },
    )
    .delete(
      "/:envId",
      async ({ project, principal, params, status }) => {
        const env = findEnv(project.id, params.envId);
        if (env === null) {
          return status(404, { error: "not_found" });
        }
        db.run("DELETE FROM environments WHERE id = ?", [env.id]);
        await secretStore.deleteEnvironmentData(project.id, env.id);
        await audit.appendAudit(
          { projectId: project.id },
          {
            action: "env.delete",
            actorType: "user",
            actorId: principal.userId,
            fields: { envId: env.id, slug: env.slug },
          },
        );
        return { deleted: true };
      },
      { requireProject: "admin" },
    );
}
