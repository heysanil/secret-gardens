import type { Database } from "bun:sqlite";
import {
  MAX_BULK_SECRETS,
  roleAllows,
  validateSecretKey,
  validateSecretValue,
} from "@safe/shared";
import { Elysia, t } from "elysia";
import { type Auth, principalPlugin } from "../auth";
import type { AuditLog } from "../redis/audit";
import type { SecretActor } from "../redis/secretStore";
import {
  DecryptFailedError,
  type SecretService,
} from "../services/secretService";

export interface SecretsDeps {
  db: Database;
  auth: Auth;
  audit: AuditLog;
  secretService: SecretService;
}

/**
 * Secrets routes under /api/projects/:projectId/environments/:envId/secrets.
 * The envId is always validated to belong to the project (else 404) so a
 * valid project role can never be replayed against another project's env.
 */
export function secretsRoutes(deps: SecretsDeps) {
  const { db, audit, secretService } = deps;

  function findEnvId(projectId: string, envId: string): string | null {
    const row = db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM environments WHERE id = ? AND project_id = ?",
      )
      .get(envId, projectId);
    return row?.id ?? null;
  }

  function actorOf(userId: string): SecretActor {
    return { type: "user", id: userId };
  }

  return (
    new Elysia({
      prefix: "/api/projects/:projectId/environments/:envId/secrets",
    })
      .use(principalPlugin(deps))
      // Decrypt failures must surface as a stable, non-leaking shape — never
      // a wrong plaintext, never Elysia's default error rendering.
      .onError(({ error, set }) => {
        if (error instanceof DecryptFailedError) {
          set.status = 500;
          return { error: "decrypt_failed" };
        }
      })
      .get(
        "/",
        async ({ project, principal, params, query, status }) => {
          const envId = findEnvId(project.id, params.envId);
          if (envId === null) {
            return status(404, { error: "not_found" });
          }
          const includeValues = query.include_values === "true";
          const secrets = await secretService.getSecrets(project.id, envId, {
            includeValues,
          });
          if (includeValues) {
            await audit.appendAudit(
              { projectId: project.id },
              {
                action: "secrets.read",
                actorType: "user",
                actorId: principal.userId,
                fields: { envId, keys: String(secrets.length) },
              },
            );
          }
          return { secrets };
        },
        { requireProject: "read" },
      )
      .put(
        "/",
        async ({ project, principal, params, body, status }) => {
          const envId = findEnvId(project.id, params.envId);
          if (envId === null) {
            return status(404, { error: "not_found" });
          }
          const entries = Object.entries(body.secrets);
          if (entries.length > MAX_BULK_SECRETS) {
            return status(422, { error: "too_many_secrets" });
          }
          const offending = entries
            .filter(
              ([key, value]) =>
                validateSecretKey(key) !== null ||
                validateSecretValue(value) !== null,
            )
            .map(([key]) => key);
          if (offending.length > 0) {
            return status(422, { error: "invalid_secrets", keys: offending });
          }

          const result = await secretService.setSecrets(
            project.id,
            envId,
            body.secrets,
            { prune: body.prune ?? false, actor: actorOf(principal.userId) },
          );

          // One audit entry per changed key; unchanged keys are silent.
          for (const [action, changes] of [
            ["secret.create", result.created],
            ["secret.update", result.updated],
            ["secret.delete", result.deleted],
          ] as const) {
            for (const change of changes) {
              await audit.appendAudit(
                { projectId: project.id },
                {
                  action,
                  actorType: "user",
                  actorId: principal.userId,
                  fields: {
                    envId,
                    key: change.key,
                    version: String(change.version),
                  },
                },
              );
            }
          }

          return {
            created: result.created.map((c) => c.key),
            updated: result.updated.map((c) => c.key),
            deleted: result.deleted.map((c) => c.key),
            unchanged: result.unchanged,
          };
        },
        {
          requireProject: "write",
          body: t.Object({
            secrets: t.Record(t.String(), t.String()),
            prune: t.Optional(t.Boolean()),
          }),
        },
      )
      .put(
        "/:key",
        async ({ project, principal, params, body, status }) => {
          const envId = findEnvId(project.id, params.envId);
          if (envId === null) {
            return status(404, { error: "not_found" });
          }
          if (validateSecretKey(params.key) !== null) {
            return status(422, { error: "invalid_key" });
          }
          if (validateSecretValue(body.value) !== null) {
            return status(422, { error: "invalid_value" });
          }
          const { version, op } = await secretService.setSecret(
            project.id,
            envId,
            params.key,
            body.value,
            actorOf(principal.userId),
          );
          await audit.appendAudit(
            { projectId: project.id },
            {
              action: op === "create" ? "secret.create" : "secret.update",
              actorType: "user",
              actorId: principal.userId,
              fields: { envId, key: params.key, version: String(version) },
            },
          );
          return { key: params.key, version, op };
        },
        {
          requireProject: "write",
          body: t.Object({ value: t.String() }),
        },
      )
      .delete(
        "/:key",
        async ({ project, principal, params, status }) => {
          const envId = findEnvId(project.id, params.envId);
          if (envId === null) {
            return status(404, { error: "not_found" });
          }
          const version = await secretService.deleteSecret(
            project.id,
            envId,
            params.key,
            actorOf(principal.userId),
          );
          if (version === null) {
            return status(404, { error: "not_found" });
          }
          await audit.appendAudit(
            { projectId: project.id },
            {
              action: "secret.delete",
              actorType: "user",
              actorId: principal.userId,
              fields: { envId, key: params.key, version: String(version) },
            },
          );
          return { deleted: true, version };
        },
        { requireProject: "write" },
      )
      .get(
        "/:key/versions",
        async ({ project, projectRole, principal, params, query, status }) => {
          const envId = findEnvId(project.id, params.envId);
          if (envId === null) {
            return status(404, { error: "not_found" });
          }
          const includeValues = query.include_values === "true";
          // Historical values are admin-only (versions.read_values): old
          // versions may hold secrets a since-rotated credential replaced.
          if (
            includeValues &&
            !roleAllows(projectRole, "versions.read_values")
          ) {
            return status(403, { error: "forbidden" });
          }
          const versions = await secretService.getSecretVersions(
            project.id,
            envId,
            params.key,
            { includeValues },
          );
          if (includeValues) {
            await audit.appendAudit(
              { projectId: project.id },
              {
                action: "secrets.read",
                actorType: "user",
                actorId: principal.userId,
                fields: { envId, key: params.key, versions: "true" },
              },
            );
          }
          return { versions };
        },
        { requireProject: "read" },
      )
      .post(
        "/:key/rollback",
        async ({ project, principal, params, body, status }) => {
          const envId = findEnvId(project.id, params.envId);
          if (envId === null) {
            return status(404, { error: "not_found" });
          }
          const result = await secretService.rollback(
            project.id,
            envId,
            params.key,
            body.toVersion,
            actorOf(principal.userId),
          );
          if (!result.ok) {
            return result.reason === "not_found"
              ? status(404, { error: "not_found" })
              : status(400, { error: "cannot_rollback_to_delete" });
          }
          await audit.appendAudit(
            { projectId: project.id },
            {
              action: "secret.rollback",
              actorType: "user",
              actorId: principal.userId,
              fields: {
                envId,
                key: params.key,
                toVersion: String(body.toVersion),
                version: String(result.version),
              },
            },
          );
          return { version: result.version };
        },
        {
          requireProject: "write",
          body: t.Object({ toVersion: t.Integer({ minimum: 1 }) }),
        },
      )
  );
}
