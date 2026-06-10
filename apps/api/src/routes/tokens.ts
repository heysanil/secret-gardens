import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { type ServiceTokenScope, TOKEN_PREFIXES } from "@safe/shared";
import { Elysia, t } from "elysia";
import { type Auth, principalPlugin } from "../auth";
import { newId } from "../db";
import type { AuditLog } from "../redis/audit";

export interface TokensDeps {
  db: Database;
  auth: Auth;
  audit: AuditLog;
}

const DAY_MS = 86_400_000;
/** Display prefix stored alongside the hash: `safe_st_` + 4 chars. */
const TOKEN_DISPLAY_PREFIX_LEN = 12;
/** ~10 years — service tokens may be long-lived but never immortal-by-typo. */
const MAX_EXPIRES_IN_DAYS = 3650;

interface ServiceTokenListRow {
  id: string;
  name: string;
  token_prefix: string;
  scope: ServiceTokenScope;
  environment_ids: string | null;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_by: string;
  created_at: number;
}

/**
 * Service-token management under /api/projects/:projectId/tokens — project
 * admins only. Service principals never pass these routes (requireProject is
 * user-only): a token must not be able to mint or revoke tokens.
 */
export function tokensRoutes(deps: TokensDeps) {
  const { db, audit } = deps;

  return new Elysia({ prefix: "/api/projects/:projectId/tokens" })
    .use(principalPlugin(deps))
    .get(
      "/",
      ({ project }) => {
        const rows = db
          .query<ServiceTokenListRow, [string]>(
            `SELECT id, name, token_prefix, scope, environment_ids,
                    expires_at, last_used_at, revoked_at, created_by, created_at
             FROM service_tokens WHERE project_id = ?
             ORDER BY created_at DESC, id`,
          )
          .all(project.id);
        return rows.map((row) => ({
          id: row.id,
          name: row.name,
          tokenPrefix: row.token_prefix,
          scope: row.scope,
          environmentIds:
            row.environment_ids === null
              ? null
              : (JSON.parse(row.environment_ids) as string[]),
          expiresAt: row.expires_at,
          lastUsedAt: row.last_used_at,
          revokedAt: row.revoked_at,
          createdBy: row.created_by,
          createdAt: row.created_at,
        }));
      },
      { requireProject: "admin" },
    )
    .post(
      "/",
      async ({ project, principal, body, set, status }) => {
        // null and omitted both mean "all environments".
        let environmentIds: string[] | null = body.environmentIds ?? null;
        if (environmentIds !== null) {
          const known = new Set(
            db
              .query<{ id: string }, [string]>(
                "SELECT id FROM environments WHERE project_id = ?",
              )
              .all(project.id)
              .map((row) => row.id),
          );
          const offenders = environmentIds.filter((id) => !known.has(id));
          if (offenders.length > 0) {
            return status(422, {
              error: "invalid_environment_ids",
              environmentIds: offenders,
            });
          }
          environmentIds = [...new Set(environmentIds)];
        }

        const token =
          TOKEN_PREFIXES.serviceToken + randomBytes(32).toString("base64url");
        const tokenPrefix = token.slice(0, TOKEN_DISPLAY_PREFIX_LEN);
        const id = newId("st");
        const now = Date.now();
        const expiresAt =
          body.expiresInDays === undefined
            ? null
            : now + body.expiresInDays * DAY_MS;
        db.run(
          `INSERT INTO service_tokens
             (id, project_id, name, token_hash, token_prefix, scope,
              environment_ids, expires_at, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            project.id,
            body.name,
            createHash("sha256").update(token).digest("hex"),
            tokenPrefix,
            body.scope,
            environmentIds === null ? null : JSON.stringify(environmentIds),
            expiresAt,
            principal.userId,
            now,
          ],
        );
        await audit.appendAudit(
          { projectId: project.id },
          {
            action: "token.create",
            actorType: "user",
            actorId: principal.userId,
            fields: {
              tokenType: "service",
              tokenId: id,
              name: body.name,
              scope: body.scope,
            },
          },
        );
        set.status = 201;
        // `token` is the only place the plaintext ever appears.
        return {
          id,
          name: body.name,
          token,
          tokenPrefix,
          scope: body.scope,
          environmentIds,
          expiresAt,
        };
      },
      {
        requireProject: "admin",
        body: t.Object({
          name: t.String({ minLength: 1, maxLength: 100 }),
          scope: t.Union([t.Literal("read"), t.Literal("read_write")]),
          environmentIds: t.Optional(
            t.Union([
              t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
              t.Null(),
            ]),
          ),
          expiresInDays: t.Optional(
            t.Integer({ minimum: 1, maximum: MAX_EXPIRES_IN_DAYS }),
          ),
        }),
      },
    )
    .delete(
      "/:tokenId",
      async ({ project, principal, params, status }) => {
        const row = db
          .query<{ id: string; revoked_at: number | null }, [string, string]>(
            "SELECT id, revoked_at FROM service_tokens WHERE id = ? AND project_id = ?",
          )
          .get(params.tokenId, project.id);
        if (row === null) {
          return status(404, { error: "not_found" });
        }
        if (row.revoked_at === null) {
          db.run("UPDATE service_tokens SET revoked_at = ? WHERE id = ?", [
            Date.now(),
            row.id,
          ]);
          await audit.appendAudit(
            { projectId: project.id },
            {
              action: "token.revoke",
              actorType: "user",
              actorId: principal.userId,
              fields: { tokenType: "service", tokenId: row.id },
            },
          );
        }
        return { revoked: true };
      },
      { requireProject: "admin" },
    );
}
