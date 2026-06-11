import type { Database } from "bun:sqlite";
import { AUDIT_ACTIONS, type AuditAction } from "@secret-gardens/shared";
import { Elysia } from "elysia";
import { type Auth, principalPlugin } from "../auth";
import type { AuditLog, ReadAuditOptions } from "../redis/audit";

export interface AuditDeps {
  db: Database;
  auth: Auth;
  audit: AuditLog;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Stream entry id shape (`<ms>-<seq>`) — the only cursor form we mint. */
const CURSOR_RE = /^\d+-\d+$/;

const KNOWN_ACTIONS: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

/**
 * GET /api/projects/:projectId/audit?cursor&limit&action&envId — any project
 * role may read its project's audit trail (audit.read is in every role's
 * permission set); service principals are denied by the user-only guard.
 */
export function auditRoutes(deps: AuditDeps) {
  const { audit } = deps;

  return new Elysia({ prefix: "/api/projects/:projectId/audit" })
    .use(principalPlugin(deps))
    .get(
      "/",
      async ({ project, query, status }) => {
        const opts: ReadAuditOptions = { limit: DEFAULT_LIMIT };
        if (query.limit !== undefined) {
          const limit = Number(query.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
            return status(422, { error: "invalid_limit" });
          }
          opts.limit = limit;
        }
        if (query.action !== undefined) {
          if (!KNOWN_ACTIONS.has(query.action)) {
            return status(422, { error: "invalid_action" });
          }
          opts.action = query.action as AuditAction;
        }
        if (query.cursor !== undefined) {
          // Cursors are opaque to clients but must be well-formed entry
          // ids before they reach Redis as an XREVRANGE bound.
          if (!CURSOR_RE.test(query.cursor)) {
            return status(422, { error: "invalid_cursor" });
          }
          opts.cursor = query.cursor;
        }
        if (query.envId !== undefined) {
          opts.envId = query.envId;
        }
        return audit.readAudit({ projectId: project.id }, opts);
      },
      { requireProject: "read" },
    );
}
