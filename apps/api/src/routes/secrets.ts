import type { Database } from "bun:sqlite";
import {
  MAX_BULK_SECRETS,
  type Principal,
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
 *
 * Service principals are admitted via requireProjectAction: GET maps to
 * 'secrets.read', the write routes to 'secrets.write' — the guard checks the
 * token's scope and environment list against the :envId. Versions stay
 * user-only (historical values outlive credential rotations).
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

  function actorOf(principal: Principal): SecretActor {
    return principal.type === "user"
      ? { type: "user", id: principal.userId }
      : { type: "service_token", id: principal.tokenId };
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
            const actor = actorOf(principal);
            await audit.appendAudit(
              { projectId: project.id },
              {
                action: "secrets.read",
                actorType: actor.type,
                actorId: actor.id,
                fields: { envId, keys: String(secrets.length) },
              },
            );
          }
          return { secrets };
        },
        {
          requireProjectAction: {
            minRole: "read",
            serviceAction: "secrets.read",
          },
        },
      )
      .get(
        "/:key",
        async ({ project, principal, params, query, status }) => {
          const envId = findEnvId(project.id, params.envId);
          if (envId === null) {
            return status(404, { error: "not_found" });
          }
          const includeValue = query.include_value === "true";
          const secret = await secretService.getSecret(
            project.id,
            envId,
            params.key,
            { includeValue },
          );
          if (secret === null) {
            return status(404, { error: "not_found" });
          }
          if (includeValue) {
            const actor = actorOf(principal);
            await audit.appendAudit(
              { projectId: project.id },
              {
                action: "secrets.read",
                actorType: actor.type,
                actorId: actor.id,
                fields: { envId, key: params.key },
              },
            );
          }
          return secret;
        },
        {
          requireProjectAction: {
            minRole: "read",
            serviceAction: "secrets.read",
          },
        },
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

          const actor = actorOf(principal);
          const result = await secretService.setSecrets(
            project.id,
            envId,
            body.secrets,
            { prune: body.prune ?? false, actor },
          );

          // One audit entry per changed key; unchanged keys are silent.
          // Appends run concurrently (Bun pipelines them on one connection);
          // XADD assigns each entry a unique id either way.
          const auditWrites: Promise<string>[] = [];
          for (const [action, changes] of [
            ["secret.create", result.created],
            ["secret.update", result.updated],
            ["secret.delete", result.deleted],
          ] as const) {
            for (const change of changes) {
              auditWrites.push(
                audit.appendAudit(
                  { projectId: project.id },
                  {
                    action,
                    actorType: actor.type,
                    actorId: actor.id,
                    fields: {
                      envId,
                      key: change.key,
                      version: String(change.version),
                    },
                  },
                ),
              );
            }
          }
          await Promise.all(auditWrites);

          return {
            created: result.created.map((c) => c.key),
            updated: result.updated.map((c) => c.key),
            deleted: result.deleted.map((c) => c.key),
            unchanged: result.unchanged,
          };
        },
        {
          requireProjectAction: {
            minRole: "write",
            serviceAction: "secrets.write",
          },
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
          const actor = actorOf(principal);
          const { version, op } = await secretService.setSecret(
            project.id,
            envId,
            params.key,
            body.value,
            actor,
          );
          await audit.appendAudit(
            { projectId: project.id },
            {
              action: op === "create" ? "secret.create" : "secret.update",
              actorType: actor.type,
              actorId: actor.id,
              fields: { envId, key: params.key, version: String(version) },
            },
          );
          return { key: params.key, version, op };
        },
        {
          requireProjectAction: {
            minRole: "write",
            serviceAction: "secrets.write",
          },
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
          const actor = actorOf(principal);
          const version = await secretService.deleteSecret(
            project.id,
            envId,
            params.key,
            actor,
          );
          if (version === null) {
            return status(404, { error: "not_found" });
          }
          await audit.appendAudit(
            { projectId: project.id },
            {
              action: "secret.delete",
              actorType: actor.type,
              actorId: actor.id,
              fields: { envId, key: params.key, version: String(version) },
            },
          );
          return { deleted: true, version };
        },
        {
          requireProjectAction: {
            minRole: "write",
            serviceAction: "secrets.write",
          },
        },
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
            // `versions` records how many historical values were actually
            // decrypted for this read (tombstones carry none).
            const decrypted = versions.filter(
              (v) => v.value !== undefined,
            ).length;
            await audit.appendAudit(
              { projectId: project.id },
              {
                action: "secrets.read",
                actorType: "user",
                actorId: principal.userId,
                fields: { envId, key: params.key, versions: String(decrypted) },
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
          const actor = actorOf(principal);
          const result = await secretService.rollback(
            project.id,
            envId,
            params.key,
            body.toVersion,
            actor,
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
              actorType: actor.type,
              actorId: actor.id,
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
          requireProjectAction: {
            minRole: "write",
            serviceAction: "secrets.write",
          },
          body: t.Object({ toVersion: t.Integer({ minimum: 1 }) }),
        },
      )
  );
}
