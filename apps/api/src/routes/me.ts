import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { TOKEN_PREFIXES } from "@secret-gardens/shared";
import { Elysia, t } from "elysia";
import { type Auth, principalPlugin } from "../auth";
import { newId } from "../db";
import type { AuditLog } from "../redis/audit";
import { ERROR_401, ERROR_403, ERROR_404 } from "./errorSchemas";

export interface MeDeps {
  db: Database;
  auth: Auth;
  audit: AuditLog;
}

const DAY_MS = 86_400_000;
/** Display prefix stored alongside the hash: `sg_ut_` + 6 chars. */
const TOKEN_DISPLAY_PREFIX_LEN = 12;
/**
 * Server-side lifetime cap for PAT-minted PATs: min(30 days, the creating
 * token's own remaining lifetime). Stops a leaked/short-lived CLI token from
 * minting longer-lived (or immortal) successors. Cookie sessions are
 * uncapped (up to the schema's 365-day maximum).
 */
const PAT_MINTED_MAX_MS = 30 * DAY_MS;

const USER_TOKEN_SCHEMA = t.Object({
  id: t.String(),
  name: t.String(),
  tokenPrefix: t.String(),
  createdAt: t.Number(),
  expiresAt: t.Union([t.Number(), t.Null()]),
  lastUsedAt: t.Union([t.Number(), t.Null()]),
  revokedAt: t.Union([t.Number(), t.Null()]),
  createdVia: t.Union([t.Literal("session"), t.Literal("token")]),
});

interface UserTokenListRow {
  id: string;
  name: string;
  token_prefix: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_via: "session" | "token";
}

/**
 * /api/me + personal access token management.
 *
 * Decision: requests authenticated WITH a PAT may list/create/revoke tokens —
 * the CLI must be able to revoke its own token at `gardens logout`.
 */
export function meRoutes(deps: MeDeps) {
  const { db, audit } = deps;
  return new Elysia()
    .use(principalPlugin(deps))
    .get(
      "/api/me",
      ({ principal, status }) => {
        const row = db
          .query<{ email: string; name: string }, [string]>(
            'SELECT email, name FROM "user" WHERE id = ?',
          )
          .get(principal.userId);
        if (row === null) {
          return status(401, { error: "unauthorized" });
        }
        return {
          type: "user" as const,
          userId: principal.userId,
          email: row.email,
          name: row.name,
          instanceRole: principal.instanceRole,
        };
      },
      {
        requireAuth: true,
        detail: {
          summary: "Current user",
          description:
            "Identity and instance role (`owner`/`admin`/`member`) of the " +
            "authenticated user. Works with a session cookie or a personal " +
            "access token; service tokens are rejected with 403 (they have " +
            "no user identity).",
          tags: ["Account"],
        },
        response: {
          200: t.Object({
            type: t.Literal("user"),
            userId: t.String(),
            email: t.String(),
            name: t.String(),
            instanceRole: t.Union([
              t.Literal("owner"),
              t.Literal("admin"),
              t.Literal("member"),
            ]),
          }),
          401: ERROR_401,
          403: ERROR_403,
        },
      },
    )
    .post(
      "/api/me/tokens",
      async ({ principal, authMethod, body, set, status }) => {
        const token =
          TOKEN_PREFIXES.userToken + randomBytes(32).toString("base64url");
        const tokenPrefix = token.slice(0, TOKEN_DISPLAY_PREFIX_LEN);
        const id = newId("ut");
        const now = Date.now();
        let expiresAt =
          body.expiresInDays === undefined
            ? null
            : now + body.expiresInDays * DAY_MS;
        const createdViaPat = authMethod.kind === "pat";
        if (authMethod.kind === "pat") {
          const cap =
            authMethod.expiresAt === null
              ? now + PAT_MINTED_MAX_MS
              : Math.min(now + PAT_MINTED_MAX_MS, authMethod.expiresAt);
          // The parent may have expired between principal resolution and
          // this point (or a skewed clock may place its expiry in the
          // past); never mint a born-expired token from it.
          if (cap <= now) {
            return status(422, { error: "parent_token_expired" });
          }
          expiresAt = expiresAt === null ? cap : Math.min(expiresAt, cap);
        }
        db.run(
          `INSERT INTO user_tokens
             (id, user_id, name, token_hash, token_prefix, expires_at, created_at, created_via)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            principal.userId,
            body.name,
            createHash("sha256").update(token).digest("hex"),
            tokenPrefix,
            expiresAt,
            now,
            createdViaPat ? "token" : "session",
          ],
        );
        await audit.appendAudit("instance", {
          action: "token.create",
          actorType: "user",
          actorId: principal.userId,
          fields: { tokenType: "user", tokenId: id, name: body.name },
        });
        set.status = 201;
        // `token` is the only place the plaintext ever appears.
        return { id, name: body.name, token, tokenPrefix, expiresAt };
      },
      {
        requireAuth: true,
        body: t.Object({
          name: t.String({ minLength: 1, maxLength: 100 }),
          expiresInDays: t.Optional(t.Integer({ minimum: 1, maximum: 365 })),
        }),
        detail: {
          summary: "Create a personal access token",
          description:
            "Mints a PAT (`sg_ut_…`) acting as the authenticated user. " +
            "**Show-once**: `token` appears only in this response — the " +
            "server stores a SHA-256 hash plus the 12-character display " +
            "prefix. When the caller authenticates with a PAT (the CLI " +
            "does), the new token's lifetime is capped at min(30 days, the " +
            "parent token's remaining lifetime); an already-expired parent " +
            "yields 422 `parent_token_expired`. Appends a `token.create` " +
            "instance audit entry.",
          tags: ["Account"],
        },
        response: {
          201: t.Object({
            id: t.String(),
            name: t.String(),
            token: t.String(),
            tokenPrefix: t.String(),
            expiresAt: t.Union([t.Number(), t.Null()]),
          }),
          401: ERROR_401,
          403: ERROR_403,
          422: t.Object({ error: t.Literal("parent_token_expired") }),
        },
      },
    )
    .get(
      "/api/me/tokens",
      ({ principal }) => {
        const rows = db
          .query<UserTokenListRow, [string]>(
            `SELECT id, name, token_prefix, created_at, expires_at, last_used_at, revoked_at, created_via
             FROM user_tokens WHERE user_id = ?
             ORDER BY created_at DESC, id`,
          )
          .all(principal.userId);
        return rows.map((row) => ({
          id: row.id,
          name: row.name,
          tokenPrefix: row.token_prefix,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          lastUsedAt: row.last_used_at,
          revokedAt: row.revoked_at,
          createdVia: row.created_via,
        }));
      },
      {
        requireAuth: true,
        detail: {
          summary: "List personal access tokens",
          description:
            "Every PAT the user has ever minted, newest first, including " +
            "revoked and expired ones (`revokedAt`/`expiresAt` tell them " +
            "apart). Only display prefixes — never token plaintext.",
          tags: ["Account"],
        },
        response: {
          200: t.Array(USER_TOKEN_SCHEMA),
          401: ERROR_401,
          403: ERROR_403,
        },
      },
    )
    .delete(
      "/api/me/tokens/:id",
      async ({ principal, params, status }) => {
        const row = db
          .query<{ id: string; revoked_at: number | null }, [string, string]>(
            "SELECT id, revoked_at FROM user_tokens WHERE id = ? AND user_id = ?",
          )
          .get(params.id, principal.userId);
        if (row === null) {
          return status(404, { error: "not_found" });
        }
        if (row.revoked_at === null) {
          db.run("UPDATE user_tokens SET revoked_at = ? WHERE id = ?", [
            Date.now(),
            row.id,
          ]);
          await audit.appendAudit("instance", {
            action: "token.revoke",
            actorType: "user",
            actorId: principal.userId,
            fields: { tokenType: "user", tokenId: row.id },
          });
        }
        return { revoked: true };
      },
      {
        requireAuth: true,
        params: t.Object({ id: t.String() }),
        detail: {
          summary: "Revoke a personal access token",
          description:
            "Revokes one of the caller's own PATs (the CLI calls this at " +
            "`gardens logout` with the very token being revoked — that is " +
            "allowed). Idempotent: re-revoking returns `revoked: true` " +
            "without a new audit entry; first revocation appends " +
            "`token.revoke` to the instance audit stream. 404 for token " +
            "ids that don't exist or belong to another user.",
          tags: ["Account"],
        },
        response: {
          200: t.Object({ revoked: t.Boolean() }),
          401: ERROR_401,
          403: ERROR_403,
          404: ERROR_404,
        },
      },
    );
}
