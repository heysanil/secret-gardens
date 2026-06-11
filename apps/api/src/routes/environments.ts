import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import { type Auth, principalPlugin } from "../auth";
import { newId } from "../db";
import type { AuditLog } from "../redis/audit";
import type { SecretStore } from "../redis/secretStore";
import { ERROR_401, ERROR_403, ERROR_404 } from "./errorSchemas";

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

const ENVIRONMENT_SCHEMA = t.Object({
  id: t.String(),
  name: t.String(),
  slug: t.String(),
  position: t.Number(),
});

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
        detail: {
          summary: "Create an environment",
          description:
            "Adds an environment to the project, appended at the end of " +
            "the ordering. Slugs (lowercase letters, digits, hyphens; max " +
            "32 chars) are **immutable after creation** — they are pinned " +
            "by CLI configs (`.gardens.json`). 422 `invalid_slug` / 409 " +
            "`duplicate_slug` on bad or taken slugs. Appends an " +
            "`env.create` audit entry. Project admins only; user " +
            "principals only.",
          tags: ["Environments"],
        },
        response: {
          201: ENVIRONMENT_SCHEMA,
          401: ERROR_401,
          403: ERROR_403,
          404: ERROR_404,
          409: t.Object({ error: t.Literal("duplicate_slug") }),
          422: t.Object({ error: t.Literal("invalid_slug") }),
        },
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
        detail: {
          summary: "Update an environment",
          description:
            "Renames an environment and/or moves its position in the " +
            "ordering. Slugs cannot be changed. Appends an `env.update` " +
            "audit entry naming the changed fields; a no-op body skips " +
            "both the write and the audit entry. Project admins only; " +
            "user principals only.",
          tags: ["Environments"],
        },
        response: {
          200: ENVIRONMENT_SCHEMA,
          401: ERROR_401,
          403: ERROR_403,
          404: ERROR_404,
        },
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
      {
        requireProject: "admin",
        detail: {
          summary: "Delete an environment",
          description:
            "Deletes the environment and **all of its secrets and version " +
            "history** (ciphertext removed from Redis). Irreversible. " +
            "Appends an `env.delete` audit entry. Project admins only; " +
            "user principals only.",
          tags: ["Environments"],
        },
        response: {
          200: t.Object({ deleted: t.Boolean() }),
          401: ERROR_401,
          403: ERROR_403,
          404: ERROR_404,
        },
      },
    );
}
