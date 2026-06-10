import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  classifyToken,
  type InstanceRole,
  type Principal,
  type ProjectRole,
  type ServiceTokenScope,
} from "@safe/shared";
import { Elysia } from "elysia";
import type { Auth } from "./index";
import { resolveProjectAccess, type ServiceAccessSpec } from "./projectGuard";

export interface PrincipalDeps {
  db: Database;
  auth: Auth;
}

/** last_used_at writes are skipped while the stored value is younger than this. */
const LAST_USED_THROTTLE_MS = 60_000;

const BEARER_RE = /^Bearer\s+(\S+)$/i;

export type PrincipalErrorCode = "invalid_token";

/**
 * How the principal authenticated. Routes that must distinguish cookie
 * sessions from Bearer PATs (e.g. the PAT-minted-token lifetime cap in
 * /api/me/tokens) read this instead of re-deriving it from headers.
 */
export type AuthMethod =
  | { kind: "session" }
  | { kind: "pat"; tokenId: string; expiresAt: number | null }
  | { kind: "service_token" };

export type PrincipalResolution =
  | { principal: Principal; errorCode: null; method: AuthMethod }
  | { principal: null; errorCode: PrincipalErrorCode | null; method: null };

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

const INVALID: PrincipalResolution = {
  principal: null,
  errorCode: "invalid_token",
  method: null,
};

interface UserTokenRow {
  id: string;
  user_id: string;
  expires_at: number | null;
  last_used_at: number | null;
}

function touchLastUsed(
  db: Database,
  table: "user_tokens" | "service_tokens",
  row: { id: string; last_used_at: number | null },
  now: number,
): void {
  if (
    row.last_used_at === null ||
    row.last_used_at < now - LAST_USED_THROTTLE_MS
  ) {
    db.run(`UPDATE ${table} SET last_used_at = ? WHERE id = ?`, [now, row.id]);
  }
}

function resolveUserToken(db: Database, token: string): PrincipalResolution {
  const now = Date.now();
  const row = db
    .query<UserTokenRow, [string, number]>(
      `SELECT id, user_id, expires_at, last_used_at FROM user_tokens
       WHERE token_hash = ?1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?2)`,
    )
    .get(sha256Hex(token), now);
  if (row === null) {
    return INVALID;
  }

  const user = db
    .query<{ role: string | null }, [string]>(
      'SELECT role FROM "user" WHERE id = ?',
    )
    .get(row.user_id);
  if (user === null) {
    return INVALID;
  }

  touchLastUsed(db, "user_tokens", row, now);

  return {
    principal: {
      type: "user",
      userId: row.user_id,
      instanceRole: parseInstanceRole(user.role),
    },
    errorCode: null,
    method: { kind: "pat", tokenId: row.id, expiresAt: row.expires_at },
  };
}

interface ServiceTokenRow {
  id: string;
  project_id: string;
  scope: ServiceTokenScope;
  environment_ids: string | null;
  last_used_at: number | null;
}

function resolveServiceToken(db: Database, token: string): PrincipalResolution {
  const now = Date.now();
  const row = db
    .query<ServiceTokenRow, [string, number]>(
      `SELECT id, project_id, scope, environment_ids, last_used_at
       FROM service_tokens
       WHERE token_hash = ?1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?2)`,
    )
    .get(sha256Hex(token), now);
  if (row === null) {
    return INVALID;
  }

  touchLastUsed(db, "service_tokens", row, now);

  return {
    principal: {
      type: "service",
      tokenId: row.id,
      projectId: row.project_id,
      scope: row.scope,
      // The column is written by the tokens route as a JSON string array
      // (or NULL = all environments); a parse failure here is data
      // corruption and must surface loudly, never widen access.
      environmentIds:
        row.environment_ids === null
          ? null
          : (JSON.parse(row.environment_ids) as string[]),
    },
    errorCode: null,
    method: { kind: "service_token" },
  };
}

/**
 * Resolves the request's principal:
 *  1. `Authorization: Bearer safe_ut_…` → PAT lookup (sha256 hash).
 *     `Bearer safe_st_…` → service-token lookup (sha256 hash). Any other
 *     Bearer value is invalid_token.
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
      return INVALID;
    }
    switch (classifyToken(token)) {
      case "user":
        return resolveUserToken(deps.db, token);
      case "service":
        return resolveServiceToken(deps.db, token);
      default:
        return INVALID;
    }
  }

  const session = await deps.auth.api.getSession({ headers: request.headers });
  if (session === null) {
    return { principal: null, errorCode: null, method: null };
  }
  const role = (session.user as { role?: string | null }).role;
  return {
    principal: {
      type: "user",
      userId: session.user.id,
      instanceRole: parseInstanceRole(role),
    },
    errorCode: null,
    method: { kind: "session" },
  };
}

/**
 * Memoizes resolvePrincipal per Request object so stacked guards on one
 * route (e.g. requireAuth + requireInstanceAdmin) share a single resolution
 * — one session lookup / one token lookup per request, not one per guard.
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
 * Effective project role of a service principal for RESPONSE SHAPING only
 * (scope read → 'read', read_write → 'write'). Authorization for service
 * principals is fully decided by serviceTokenAllows inside the guard —
 * never feed this value into roleAllows for a service principal: it would
 * grant role permissions (versions.read, audit.read, …) the token must not
 * have.
 */
function serviceEffectiveRole(scope: ServiceTokenScope): ProjectRole {
  return scope === "read_write" ? "write" : "read";
}

/**
 * Route guards as Elysia macros:
 *   { requireAuth: true }          → 401 unless a principal resolves; 403 for
 *                                    service principals (no project context)
 *   { requireInstanceAdmin: true } → additionally 403 unless owner/admin
 *   { requireProject: minRole }    → project-scoped access on :projectId for
 *                                    USER principals only; service principals
 *                                    get 403 on their own project, 404
 *                                    elsewhere. Exposes {project, principal,
 *                                    projectRole}.
 *   { requireProjectAction: {minRole, serviceAction} }
 *                                  → like requireProject for users, but also
 *                                    admits service principals whose token
 *                                    allows `serviceAction` (see
 *                                    ServiceAccessSpec). Exposes a Principal.
 * All guards share one memoized principal resolution per request.
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
        return { principal: res.principal, authMethod: res.method };
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
    requireProject: (minRole: ProjectRole) => ({
      async resolve({ request, params, status }) {
        const access = resolveProjectAccess(
          deps.db,
          await resolveOnce(request),
          (params as Record<string, string | undefined>).projectId,
          minRole,
        );
        switch (access.kind) {
          case "unauthorized":
            return status(401, { error: access.error });
          case "not_found":
            return status(404, { error: "not_found" });
          case "forbidden":
            return status(403, { error: "forbidden" });
          case "ok_service":
            // Unreachable: without a ServiceAccessSpec the guard resolves
            // service principals to forbidden/not_found. Kept exhaustive.
            return status(403, { error: "forbidden" });
          case "ok":
            return {
              project: access.project,
              principal: access.principal,
              projectRole: access.projectRole,
            };
        }
      },
    }),
    requireProjectAction: (opts: {
      minRole: ProjectRole;
      serviceAction: ServiceAccessSpec["action"];
    }) => ({
      async resolve({ request, params, status }) {
        const routeParams = params as Record<string, string | undefined>;
        const access = resolveProjectAccess(
          deps.db,
          await resolveOnce(request),
          routeParams.projectId,
          opts.minRole,
          { action: opts.serviceAction, envId: routeParams.envId },
        );
        switch (access.kind) {
          case "unauthorized":
            return status(401, { error: access.error });
          case "not_found":
            return status(404, { error: "not_found" });
          case "forbidden":
            return status(403, { error: "forbidden" });
          case "ok":
            return {
              project: access.project,
              principal: access.principal as Principal,
              projectRole: access.projectRole,
            };
          case "ok_service":
            return {
              project: access.project,
              principal: access.principal as Principal,
              projectRole: serviceEffectiveRole(access.principal.scope),
            };
        }
      },
    }),
  });
}
