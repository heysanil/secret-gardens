import type { Database } from "bun:sqlite";
import {
  type ProjectRole,
  resolveProjectRole,
  type ServicePrincipal,
  serviceTokenAllows,
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
 * What a route allows a service principal to do. Routes that pass no
 * ServiceAccessSpec deny service principals outright (403 on their own
 * project, 404 elsewhere — the existence rule is unchanged).
 *
 *  - 'secrets.read' / 'secrets.write': checked via serviceTokenAllows against
 *    the route's :envId param (validated to belong to the project first).
 *  - 'project.read': DELIBERATE exception — a service token may read its own
 *    project's detail (filtered by the route handler) so CI can resolve
 *    environment slugs to ids for `safe pull`.
 */
export interface ServiceAccessSpec {
  action: "secrets.read" | "secrets.write" | "project.read";
  /** The :envId route param; required for the secrets actions. */
  envId?: string;
}

/**
 * Decision of the requireProject guards, as data. The macros in principal.ts
 * map each variant onto an HTTP response:
 *   unauthorized → 401 {error: …}
 *   not_found    → 404 {error:'not_found'}
 *   forbidden    → 403 {error:'forbidden'}
 *   ok           → context {project, principal: UserPrincipal, projectRole}
 *   ok_service   → context {project, principal: ServicePrincipal}
 */
export type ProjectAccess =
  | { kind: "unauthorized"; error: PrincipalErrorCode | "unauthorized" }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | {
      kind: "ok";
      project: ProjectRow;
      principal: UserPrincipal;
      projectRole: ProjectRole;
    }
  | { kind: "ok_service"; project: ProjectRow; principal: ServicePrincipal };

/**
 * Resolves whether the principal may act on the project at `minRole`.
 *
 * Users:
 * - Nonexistent project AND no-access user both yield not_found — a 403
 *   would leak which project ids exist.
 * - Instance owners/admins are implicit project admins (resolveProjectRole).
 *
 * Service principals:
 * - Any project other than the token's own (existing or not) → not_found,
 *   matching the user existence rule: a token cannot probe project ids.
 * - Own project but the route grants no service access → forbidden.
 * - 'secrets.*' actions: the :envId must belong to the project (else
 *   not_found, exactly as the route would respond for a user), then
 *   serviceTokenAllows decides — wrong scope or an env outside the token's
 *   environmentIds → forbidden.
 */
export function resolveProjectAccess(
  db: Database,
  resolution: PrincipalResolution,
  projectId: string | undefined,
  minRole: ProjectRole,
  service?: ServiceAccessSpec,
): ProjectAccess {
  if (resolution.errorCode !== null) {
    return { kind: "unauthorized", error: resolution.errorCode };
  }
  if (resolution.principal === null) {
    return { kind: "unauthorized", error: "unauthorized" };
  }
  if (projectId === undefined) {
    return { kind: "not_found" };
  }

  if (resolution.principal.type === "service") {
    return resolveServiceAccess(db, resolution.principal, projectId, service);
  }

  const project = findProject(db, projectId);
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

function findProject(db: Database, projectId: string): ProjectRow | null {
  return db
    .query<ProjectRow, [string]>(
      `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`,
    )
    .get(projectId);
}

function resolveServiceAccess(
  db: Database,
  principal: ServicePrincipal,
  projectId: string,
  service: ServiceAccessSpec | undefined,
): ProjectAccess {
  if (principal.projectId !== projectId) {
    return { kind: "not_found" };
  }
  const project = findProject(db, projectId);
  if (project === null) {
    // Token rows cascade with their project, but a cached/in-flight
    // resolution must still never invent a project row.
    return { kind: "not_found" };
  }
  if (service === undefined) {
    return { kind: "forbidden" };
  }
  if (service.action === "project.read") {
    return { kind: "ok_service", project, principal };
  }
  if (service.envId === undefined) {
    // Secrets actions always come from routes with an :envId param; a
    // missing param means a miswired route — deny safely.
    return { kind: "not_found" };
  }
  const env = db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM environments WHERE id = ? AND project_id = ?",
    )
    .get(service.envId, projectId);
  if (env === null) {
    return { kind: "not_found" };
  }
  if (!serviceTokenAllows(principal, service.action, projectId, env.id)) {
    return { kind: "forbidden" };
  }
  return { kind: "ok_service", project, principal };
}
