import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { classifyToken, type InstanceRole, type Principal } from "@safe/shared";
import { Elysia } from "elysia";
import type { Auth } from "./index";

export interface PrincipalDeps {
  db: Database;
  auth: Auth;
}

/** last_used_at writes are skipped while the stored value is younger than this. */
const LAST_USED_THROTTLE_MS = 60_000;

const BEARER_RE = /^Bearer\s+(\S+)$/i;

export type PrincipalErrorCode = "invalid_token" | "service_tokens_not_enabled";

export type PrincipalResolution =
  | { principal: Principal | null; errorCode: null }
  | { principal: null; errorCode: PrincipalErrorCode };

/**
 * Maps better-auth's free-form `user.role` string (possibly a comma-separated
 * list) onto our InstanceRole, highest privilege first. Unknown/missing
 * values degrade to 'member'.
 */
export function parseInstanceRole(
  role: string | null | undefined,
): InstanceRole {
  const roles = (role ?? "").split(",").map((r) => r.trim());
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  return "member";
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface UserTokenRow {
  id: string;
  user_id: string;
  last_used_at: number | null;
}

function resolveUserToken(db: Database, token: string): PrincipalResolution {
  const now = Date.now();
  const row = db
    .query<UserTokenRow, [string, number]>(
      `SELECT id, user_id, last_used_at FROM user_tokens
       WHERE token_hash = ?1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?2)`,
    )
    .get(sha256Hex(token), now);
  if (row === null) {
    return { principal: null, errorCode: "invalid_token" };
  }

  const user = db
    .query<{ role: string | null }, [string]>(
      'SELECT role FROM "user" WHERE id = ?',
    )
    .get(row.user_id);
  if (user === null) {
    return { principal: null, errorCode: "invalid_token" };
  }

  if (
    row.last_used_at === null ||
    row.last_used_at < now - LAST_USED_THROTTLE_MS
  ) {
    db.run("UPDATE user_tokens SET last_used_at = ? WHERE id = ?", [
      now,
      row.id,
    ]);
  }

  return {
    principal: {
      type: "user",
      userId: row.user_id,
      instanceRole: parseInstanceRole(user.role),
    },
    errorCode: null,
  };
}

/**
 * Resolves the request's principal:
 *  1. `Authorization: Bearer safe_ut_…` → PAT lookup (sha256 hash).
 *     `safe_st_…` is rejected until Phase 6; any other Bearer value is
 *     invalid_token.
 *  2. Otherwise, better-auth cookie session.
 *  3. Neither → null principal (routes decide via guards).
 */
export async function resolvePrincipal(
  deps: PrincipalDeps,
  request: Request,
): Promise<PrincipalResolution> {
  const header = request.headers.get("authorization");
  if (header !== null) {
    const token = BEARER_RE.exec(header)?.[1];
    if (token === undefined) {
      return { principal: null, errorCode: "invalid_token" };
    }
    switch (classifyToken(token)) {
      case "user":
        return resolveUserToken(deps.db, token);
      case "service":
        return { principal: null, errorCode: "service_tokens_not_enabled" };
      default:
        return { principal: null, errorCode: "invalid_token" };
    }
  }

  const session = await deps.auth.api.getSession({ headers: request.headers });
  if (session === null) {
    return { principal: null, errorCode: null };
  }
  const role = (session.user as { role?: string | null }).role;
  return {
    principal: {
      type: "user",
      userId: session.user.id,
      instanceRole: parseInstanceRole(role),
    },
    errorCode: null,
  };
}

/**
 * Memoizes resolvePrincipal per Request object so stacked guards on one
 * route (e.g. requireAuth + requireInstanceAdmin) share a single resolution
 * — one session lookup / one PAT lookup per request, not one per guard.
 */
export function createPrincipalResolver(
  deps: PrincipalDeps,
): (request: Request) => Promise<PrincipalResolution> {
  const cache = new WeakMap<Request, Promise<PrincipalResolution>>();
  return (request) => {
    let pending = cache.get(request);
    if (pending === undefined) {
      pending = resolvePrincipal(deps, request);
      cache.set(request, pending);
    }
    return pending;
  };
}

/**
 * Route guards as Elysia macros:
 *   { requireAuth: true }          → 401 unless a user principal resolves
 *   { requireInstanceAdmin: true } → additionally 403 unless owner/admin
 * Both expose a typed UserPrincipal to the handler and share one memoized
 * principal resolution per request. Service principals (Phase 6) never pass
 * these guards — secrets routes will get their own project-scoped guard;
 * user/member/token/admin routes stay user-only.
 */
export function principalPlugin(deps: PrincipalDeps) {
  const resolveOnce = createPrincipalResolver(deps);
  return new Elysia({ name: "principal" }).macro({
    requireAuth: {
      async resolve({ request, status }) {
        const res = await resolveOnce(request);
        if (res.errorCode !== null) {
          return status(401, { error: res.errorCode });
        }
        if (res.principal === null) {
          return status(401, { error: "unauthorized" });
        }
        if (res.principal.type !== "user") {
          return status(403, { error: "forbidden" });
        }
        return { principal: res.principal };
      },
    },
    requireInstanceAdmin: {
      async resolve({ request, status }) {
        const res = await resolveOnce(request);
        if (res.errorCode !== null) {
          return status(401, { error: res.errorCode });
        }
        if (res.principal === null) {
          return status(401, { error: "unauthorized" });
        }
        if (
          res.principal.type !== "user" ||
          (res.principal.instanceRole !== "owner" &&
            res.principal.instanceRole !== "admin")
        ) {
          return status(403, { error: "forbidden" });
        }
        return { principal: res.principal };
      },
    },
  });
}
