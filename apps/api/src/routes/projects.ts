import type { Database } from "bun:sqlite";
import { type ProjectRole, resolveProjectRole } from "@safe/shared";
import { Elysia, t } from "elysia";
import { type Auth, principalPlugin } from "../auth";
import { PROJECT_COLUMNS, type ProjectRow } from "../auth/projectGuard";
import { newId } from "../db";
import type { AuditLog } from "../redis/audit";
import type { RedisLike } from "../redis/client";
import type { SecretStore } from "../redis/secretStore";
import type { DekService } from "../services/dekService";
import {
  DecryptFailedError,
  type SecretService,
} from "../services/secretService";

export interface ProjectsDeps {
  db: Database;
  auth: Auth;
  audit: AuditLog;
  redis: RedisLike;
  dekService: DekService;
  secretService: SecretService;
  secretStore: SecretStore;
}

export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** 'My App!' → 'my-app'. May produce '' (all-symbol names) — caller validates. */
export function deriveProjectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

const DEFAULT_ENVIRONMENTS = [
  { name: "Development", slug: "dev" },
  { name: "Staging", slug: "staging" },
  { name: "Production", slug: "prod" },
] as const;

interface EnvironmentRow {
  id: string;
  name: string;
  slug: string;
  position: number;
}

interface ProjectListRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: number;
  environment_count: number;
  membership_role: ProjectRole | null;
}

export function projectsRoutes(deps: ProjectsDeps) {
  const { db, audit, redis, dekService, secretService, secretStore } = deps;

  function environmentsOf(projectId: string): EnvironmentRow[] {
    return db
      .query<EnvironmentRow, [string]>(
        `SELECT id, name, slug, position FROM environments
         WHERE project_id = ? ORDER BY position, id`,
      )
      .all(projectId);
  }

  function getProject(projectId: string): ProjectRow {
    const row = db
      .query<ProjectRow, [string]>(
        `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`,
      )
      .get(projectId);
    if (row === null) {
      throw new Error(`project ${projectId} disappeared mid-request`);
    }
    return row;
  }

  function detail(project: ProjectRow, role: ProjectRole) {
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      description: project.description,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
      role,
      environments: environmentsOf(project.id),
    };
  }

  return (
    new Elysia()
      .use(principalPlugin(deps))
      // DEK rotation decrypts every secret; map decrypt failures to a stable
      // shape instead of Elysia's default 500.
      .onError(({ error, set }) => {
        if (error instanceof DecryptFailedError) {
          set.status = 500;
          return { error: "decrypt_failed" };
        }
      })
      .get(
        "/api/projects",
        ({ principal }) => {
          const isInstanceAdmin =
            principal.instanceRole === "owner" ||
            principal.instanceRole === "admin";
          // Instance owners/admins see every project; members only those
          // they have joined.
          const rows = db
            .query<ProjectListRow, [string]>(
              `SELECT p.id, p.name, p.slug, p.description, p.created_at,
                      (SELECT COUNT(*) FROM environments e WHERE e.project_id = p.id) AS environment_count,
                      m.role AS membership_role
               FROM projects p
               ${isInstanceAdmin ? "LEFT" : "INNER"} JOIN project_memberships m
                 ON m.project_id = p.id AND m.user_id = ?
               ORDER BY p.created_at, p.id`,
            )
            .all(principal.userId);
          return rows.map((row) => ({
            id: row.id,
            name: row.name,
            slug: row.slug,
            description: row.description,
            createdAt: row.created_at,
            environmentCount: row.environment_count,
            role: resolveProjectRole(
              principal.instanceRole,
              row.membership_role,
            ) as ProjectRole,
          }));
        },
        { requireAuth: true },
      )
      .post(
        "/api/projects",
        async ({ principal, body, set, status }) => {
          const slug = body.slug ?? deriveProjectSlug(body.name);
          if (!PROJECT_SLUG_RE.test(slug)) {
            return status(422, { error: "invalid_slug" });
          }
          if (
            db.query("SELECT id FROM projects WHERE slug = ?").get(slug) !==
            null
          ) {
            return status(409, { error: "duplicate_slug" });
          }

          const projectId = newId("prj");
          const now = Date.now();
          db.transaction(() => {
            db.run(
              `INSERT INTO projects (id, name, slug, description, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                projectId,
                body.name,
                slug,
                body.description ?? null,
                principal.userId,
                now,
                now,
              ],
            );
            DEFAULT_ENVIRONMENTS.forEach((env, position) => {
              db.run(
                `INSERT INTO environments (id, project_id, name, slug, position, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [newId("env"), projectId, env.name, env.slug, position, now],
              );
            });
            db.run(
              `INSERT INTO project_memberships (id, project_id, user_id, role, created_at)
               VALUES (?, ?, ?, 'admin', ?)`,
              [newId("mem"), projectId, principal.userId, now],
            );
          })();

          // DEK creation deliberately happens AFTER the commit: a wrap/insert
          // failure must not poison the surrounding transaction, so instead
          // we compensate by deleting the project row (cascade removes the
          // envs and membership) and rethrowing.
          try {
            dekService.createProjectDek(projectId);
          } catch (err) {
            try {
              db.run("DELETE FROM projects WHERE id = ?", [projectId]);
            } catch (cleanupErr) {
              // The cleanup failure must not mask the original DEK error;
              // log the orphaned row (a project without a DEK is unusable
              // but harmless) and surface the root cause below.
              console.error(
                `failed to clean up project ${projectId} after DEK creation error:`,
                cleanupErr,
              );
            }
            throw err;
          }

          await audit.appendAudit(
            { projectId },
            {
              action: "project.create",
              actorType: "user",
              actorId: principal.userId,
              fields: { name: body.name, slug },
            },
          );
          await audit.appendAudit("instance", {
            action: "project.create",
            actorType: "user",
            actorId: principal.userId,
            fields: { projectId, slug },
          });

          set.status = 201;
          return detail(
            getProject(projectId),
            resolveProjectRole(principal.instanceRole, "admin") as ProjectRole,
          );
        },
        {
          requireAuth: true,
          body: t.Object({
            name: t.String({ minLength: 1, maxLength: 100 }),
            slug: t.Optional(t.String({ minLength: 1, maxLength: 63 })),
            description: t.Optional(t.String({ maxLength: 500 })),
          }),
        },
      )
      .get(
        "/api/projects/:projectId",
        ({ project, principal, projectRole }) => {
          if (principal.type === "service" || projectRole === null) {
            // DELIBERATE service-token exception: CI needs the project
            // detail to resolve environment slugs → ids before pulling
            // secrets. The response is filtered — id/name/slug plus only
            // the environments the token may access (all when the token is
            // unscoped); no role/description/timestamps. projectRole is
            // null exactly for service principals; checking both narrows
            // the type for the user branch below.
            const allowedEnvIds =
              principal.type === "service" ? principal.environmentIds : null;
            const environments = environmentsOf(project.id).filter(
              (env) => allowedEnvIds === null || allowedEnvIds.includes(env.id),
            );
            return {
              id: project.id,
              name: project.name,
              slug: project.slug,
              environments,
            };
          }
          return detail(project, projectRole);
        },
        {
          requireProjectAction: {
            minRole: "read",
            serviceAction: "project.read",
          },
        },
      )
      .patch(
        "/api/projects/:projectId",
        async ({ project, projectRole, principal, body }) => {
          const changed: string[] = [];
          if (body.name !== undefined) changed.push("name");
          if (body.description !== undefined) changed.push("description");
          if (changed.length > 0) {
            db.run(
              "UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?",
              [
                body.name ?? project.name,
                body.description === undefined
                  ? project.description
                  : body.description,
                Date.now(),
                project.id,
              ],
            );
            await audit.appendAudit(
              { projectId: project.id },
              {
                action: "project.update",
                actorType: "user",
                actorId: principal.userId,
                fields: { changed: changed.join(",") },
              },
            );
          }
          return detail(getProject(project.id), projectRole);
        },
        {
          requireProject: "admin",
          body: t.Object({
            name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
            description: t.Optional(t.String({ maxLength: 500 })),
          }),
        },
      )
      .delete(
        "/api/projects/:projectId",
        async ({ project, principal }) => {
          // Acknowledged tradeoff: a crash between the sqlite delete and the
          // redis cleanup below leaves orphaned redis keys. They are
          // unreachable (every route resolves the project row first) and
          // harmless; an ops sweep is documented in the Phase 9 docs.
          db.run("DELETE FROM projects WHERE id = ?", [project.id]);
          dekService.invalidate(project.id);
          await secretStore.deleteProjectData(project.id);
          // Data hygiene: the per-project audit stream goes with the project
          // (key shape matches redis/audit.ts streamKey). The instance
          // stream keeps the deletion record below.
          await redis.send("UNLINK", [`audit:${project.id}`]);
          await audit.appendAudit("instance", {
            action: "project.delete",
            actorType: "user",
            actorId: principal.userId,
            fields: { projectId: project.id, slug: project.slug },
          });
          return { deleted: true };
        },
        { requireProject: "admin" },
      )
      .post(
        "/api/projects/:projectId/rotate-dek",
        async ({ project, principal }) => {
          const envIds = db
            .query<{ id: string }, [string]>(
              "SELECT id FROM environments WHERE project_id = ?",
            )
            .all(project.id)
            .map((row) => row.id);
          const result = await secretService.rotateProjectSecrets(
            project.id,
            envIds,
          );
          await audit.appendAudit(
            { projectId: project.id },
            {
              action: "dek.rotate",
              actorType: "user",
              actorId: principal.userId,
              fields: {
                oldVersion: String(result.oldVersion),
                newVersion: String(result.newVersion),
                secretsRewritten: String(result.secretsRewritten),
              },
            },
          );
          await audit.appendAudit("instance", {
            action: "dek.rotate",
            actorType: "user",
            actorId: principal.userId,
            fields: {
              projectId: project.id,
              oldVersion: String(result.oldVersion),
              newVersion: String(result.newVersion),
            },
          });
          return result;
        },
        { requireProject: "admin" },
      )
  );
}
