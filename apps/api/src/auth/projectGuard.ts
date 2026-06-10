import type { Database } from "bun:sqlite";
import {
  type ProjectRole,
  resolveProjectRole,
  type UserPrincipal,
} from "@safe/shared";
import type { PrincipalErrorCode, PrincipalResolution } from "./principal";

/** A row of the projects table, as handed to route handlers by the guard. */
export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export const PROJECT_COLUMNS =
  "id, name, slug, description, created_by, created_at, updated_at";

const ROLE_RANK: Record<ProjectRole, number> = { read: 0, write: 1, admin: 2 };

/**
 * Decision of the requireProject guard, as data. The macro in principal.ts
 * maps each variant onto an HTTP response:
 *   unauthorized        → 401 {error: …}
 *   service_unsupported → 401 {error:'service_tokens_not_enabled'}
 *   not_found           → 404 {error:'not_found'}
 *   forbidden           → 403 {error:'forbidden'}
 *   ok                  → context {project, principal, projectRole}
 */
export type ProjectAccess =
  | { kind: "unauthorized"; error: PrincipalErrorCode | "unauthorized" }
  | { kind: "service_unsupported" }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | {
      kind: "ok";
      project: ProjectRow;
      principal: UserPrincipal;
      projectRole: ProjectRole;
    };

/**
 * Resolves whether the principal may act on the project at `minRole`.
 *
 * - Nonexistent project AND no-access user both yield not_found — a 403
 *   would leak which project ids exist.
 * - Instance owners/admins are implicit project admins (resolveProjectRole).
 * - PHASE 6 SEAM: service principals are rejected here today; service-token
 *   support will add a branch mapping ServicePrincipal scopes onto project
 *   access (serviceTokenAllows) instead of `service_unsupported`.
 */
export function resolveProjectAccess(
  db: Database,
  resolution: PrincipalResolution,
  projectId: string | undefined,
  minRole: ProjectRole,
): ProjectAccess {
  if (resolution.errorCode !== null) {
    return { kind: "unauthorized", error: resolution.errorCode };
  }
  if (resolution.principal === null) {
    return { kind: "unauthorized", error: "unauthorized" };
  }
  if (resolution.principal.type !== "user") {
    return { kind: "service_unsupported" };
  }
  if (projectId === undefined) {
    return { kind: "not_found" };
  }

  const project = db
    .query<ProjectRow, [string]>(
      `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`,
    )
    .get(projectId);
  if (project === null) {
    return { kind: "not_found" };
  }

  const membership = db
    .query<{ role: ProjectRole }, [string, string]>(
      "SELECT role FROM project_memberships WHERE project_id = ? AND user_id = ?",
    )
    .get(projectId, resolution.principal.userId);
  const projectRole = resolveProjectRole(
    resolution.principal.instanceRole,
    membership?.role ?? null,
  );
  if (projectRole === null) {
    return { kind: "not_found" };
  }
  if (ROLE_RANK[projectRole] < ROLE_RANK[minRole]) {
    return { kind: "forbidden" };
  }
  return {
    kind: "ok",
    project,
    principal: resolution.principal,
    projectRole,
  };
}
