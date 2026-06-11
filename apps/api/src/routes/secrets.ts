import type { Database } from "bun:sqlite";
import {
  MAX_BULK_SECRETS,
  type Principal,
  roleAllows,
  validateSecretKey,
  validateSecretValue,
} from "@secret-gardens/shared";
import { Elysia, t } from "elysia";
import { type Auth, principalPlugin } from "../auth";
import type { AuditLog } from "../redis/audit";
import type { SecretActor } from "../redis/secretStore";
import {
  DecryptFailedError,
  type SecretService,
} from "../services/secretService";
import {
  ERROR_401,
  ERROR_403,
  ERROR_404,
  ERROR_500_DECRYPT,
} from "./errorSchemas";

export interface SecretsDeps {
  db: Database;
  auth: Auth;
  audit: AuditLog;
  secretService: SecretService;
}

const SECRET_ENTRY_SCHEMA = t.Object({
  key: t.String(),
  version: t.Number(),
  updatedAt: t.Number(),
  updatedBy: t.String(),
  value: t.Optional(t.String()),
});

const VERSION_ENTRY_SCHEMA = t.Object({
  version: t.Number(),
  op: t.Union([
    t.Literal("create"),
    t.Literal("update"),
    t.Literal("delete"),
    t.Literal("rollback"),
  ]),
  // AuditActorType — "system" never actually writes secret versions, but
  // the storage type admits it.
  actorType: t.Union([
    t.Literal("user"),
    t.Literal("service_token"),
    t.Literal("system"),
  ]),
  actorId: t.String(),
  ts: t.Number(),
  rollbackOf: t.Optional(t.Number()),
  hasValue: t.Boolean(),
  value: t.Optional(t.String()),
});

const WRITE_OP_SCHEMA = t.Union([
  t.Literal("create"),
  t.Literal("update"),
  t.Literal("rollback"),
]);

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
          query: t.Object({
            include_values: t.Optional(
              t.String({
                description:
                  "Set to `true` to decrypt and include every value " +
                  "(appends a `secrets.read` audit entry).",
              }),
            ),
          }),
          detail: {
            summary: "List secrets",
            description:
              "Current secrets in the environment (tombstoned keys " +
              "excluded), sorted by key. Metadata only by default; " +
              "`?include_values=true` decrypts every value and appends a " +
              "`secrets.read` audit entry recording the actor and count. " +
              "Service tokens: allowed with scope `read` or `read_write` " +
              "when the token covers this environment (`gardens pull/run` " +
              "use this).",
            tags: ["Secrets"],
          },
          response: {
            200: t.Object({ secrets: t.Array(SECRET_ENTRY_SCHEMA) }),
            401: ERROR_401,
            403: ERROR_403,
            404: ERROR_404,
            500: ERROR_500_DECRYPT,
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
          query: t.Object({
            include_value: t.Optional(
              t.String({
                description:
                  "Set to `true` to decrypt and include the value " +
                  "(appends a `secrets.read` audit entry).",
              }),
            ),
          }),
          detail: {
            summary: "Get a secret",
            description:
              "One current secret. Metadata only by default; " +
              "`?include_value=true` decrypts the value and appends a " +
              "`secrets.read` audit entry. 404 when the key has no " +
              "current value (never existed, or tombstoned by delete). " +
              "Service tokens: allowed with scope `read` or `read_write` " +
              "when the token covers this environment.",
            tags: ["Secrets"],
          },
          response: {
            200: SECRET_ENTRY_SCHEMA,
            401: ERROR_401,
            403: ERROR_403,
            404: ERROR_404,
            500: ERROR_500_DECRYPT,
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
          detail: {
            summary: "Bulk upsert secrets",
            description:
              "Idempotent bulk write (`gardens push`). Keys whose current " +
              "value already equals the incoming one are left untouched " +
              "(no version bump, no audit entry); changed keys get a new " +
              "version and a `secret.create`/`secret.update` audit entry " +
              "each. With `prune: true`, current keys absent from the " +
              "payload are tombstoned (versioned `secret.delete`, " +
              "reversible via rollback). Max 1000 entries (422 " +
              "`too_many_secrets`); invalid keys/values are rejected " +
              "as a whole with 422 `invalid_secrets` naming the " +
              "offending keys — never their values. Service tokens: " +
              "requires scope `read_write` covering this environment. " +
              "Project role `write`+ for users.",
            tags: ["Secrets"],
          },
          response: {
            200: t.Object({
              created: t.Array(t.String()),
              updated: t.Array(t.String()),
              deleted: t.Array(t.String()),
              unchanged: t.Number(),
            }),
            401: ERROR_401,
            403: ERROR_403,
            404: ERROR_404,
            422: t.Union([
              t.Object({ error: t.Literal("too_many_secrets") }),
              t.Object({
                error: t.Literal("invalid_secrets"),
                keys: t.Array(t.String()),
              }),
            ]),
            500: ERROR_500_DECRYPT,
          },
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
          detail: {
            summary: "Set a secret",
            description:
              "Creates or updates one secret (`gardens secrets set`); " +
              "`op` in the response says which happened. Every write " +
              "appends a new version (history is append-only) and a " +
              "`secret.create`/`secret.update` audit entry. Unlike the " +
              "bulk route, an unchanged value still bumps the version. " +
              "422 `invalid_key`/`invalid_value` on validation failure. " +
              "Service tokens: requires scope `read_write` covering this " +
              "environment. Project role `write`+ for users.",
            tags: ["Secrets"],
          },
          response: {
            200: t.Object({
              key: t.String(),
              version: t.Number(),
              op: WRITE_OP_SCHEMA,
            }),
            401: ERROR_401,
            403: ERROR_403,
            404: ERROR_404,
            422: t.Union([
              t.Object({ error: t.Literal("invalid_key") }),
              t.Object({ error: t.Literal("invalid_value") }),
            ]),
          },
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
          detail: {
            summary: "Delete a secret",
            description:
              "Tombstones the key: it disappears from current listings " +
              "but its history is preserved (history is append-only — " +
              "the deletion itself is a version, and earlier versions " +
              "remain roll-back-able). 404 when there is no current " +
              "value. Appends a `secret.delete` audit entry. Service " +
              "tokens: requires scope `read_write` covering this " +
              "environment. Project role `write`+ for users.",
            tags: ["Secrets"],
          },
          response: {
            200: t.Object({ deleted: t.Boolean(), version: t.Number() }),
            401: ERROR_401,
            403: ERROR_403,
            404: ERROR_404,
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
        {
          requireProject: "read",
          query: t.Object({
            include_values: t.Optional(
              t.String({
                description:
                  "Set to `true` to decrypt historical values — project " +
                  "admins only (403 otherwise).",
              }),
            ),
          }),
          detail: {
            summary: "List a secret's versions",
            description:
              "Full append-only history for one key, newest first — " +
              "including deletion tombstones (`hasValue: false`) and " +
              "rollback entries (`rollbackOf`). Metadata for any project " +
              "role; `?include_values=true` is **project-admin-only** " +
              "(403 `forbidden`): old versions may hold values a " +
              "since-rotated credential replaced. Value reads append a " +
              "`secrets.read` audit entry with the decrypted count. " +
              "User principals only — service tokens never read history.",
            tags: ["Versions"],
          },
          response: {
            200: t.Object({ versions: t.Array(VERSION_ENTRY_SCHEMA) }),
            401: ERROR_401,
            403: ERROR_403,
            404: ERROR_404,
            500: ERROR_500_DECRYPT,
          },
        },
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
          detail: {
            summary: "Roll back a secret",
            description:
              "Appends a NEW version that reuses the target version's " +
              "ciphertext verbatim — history is never rewritten, and the " +
              "rollback itself is recorded as an `op: rollback` version " +
              "plus a `secret.rollback` audit entry. Rolling back to a " +
              "deletion tombstone is refused with 400 " +
              "`cannot_rollback_to_delete` (delete the key instead); " +
              "unknown versions 404. Service tokens: requires scope " +
              "`read_write` covering this environment. Project role " +
              "`write`+ for users.",
            tags: ["Versions"],
          },
          response: {
            200: t.Object({ version: t.Number() }),
            400: t.Object({
              error: t.Literal("cannot_rollback_to_delete"),
            }),
            401: ERROR_401,
            403: ERROR_403,
            404: ERROR_404,
          },
        },
      )
  );
}
