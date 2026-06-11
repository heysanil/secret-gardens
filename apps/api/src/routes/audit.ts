import type { Database } from "bun:sqlite";
import { AUDIT_ACTIONS, type AuditAction } from "@secret-gardens/shared";
import { Elysia, t } from "elysia";
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
      {
        requireProject: "read",
        // Documented as parameters only — the handler does the validation
        // (the 422 codes below), since limits/cursors/actions have
        // semantics plain string schemas cannot express.
        query: t.Object({
          cursor: t.Optional(
            t.String({
              description:
                "Opaque exclusive cursor from a previous page's " +
                "`nextCursor`. Omit for the newest entries.",
            }),
          ),
          limit: t.Optional(
            t.String({
              description: "Page size, 1–100 (default 50).",
            }),
          ),
          action: t.Optional(
            t.String({
              description:
                "Filter to one audit action (e.g. `secret.update`); 422 " +
                "`invalid_action` for unknown actions.",
            }),
          ),
          envId: t.Optional(
            t.String({
              description: "Filter to entries whose `envId` field matches.",
            }),
          ),
        }),
        // Doc-only responses (no runtime schema): entry `fields` are a
        // free-form string map that varies per action.
        detail: {
          summary: "Read the project audit trail",
          description:
            "Append-only audit stream for the project, newest first, " +
            "cursor-paginated (see the Pagination section of this " +
            "document). Entries record the action (e.g. `secret.update`, " +
            "`member.add`, `dek.rotate`), the actor (user or service " +
            "token), a timestamp, and per-action string fields flattened " +
            "onto the entry itself (e.g. `envId`, `key`, `version`) — " +
            "keys, ids, and counts, **never secret values**. Any project " +
            "may read it; service tokens get 403/404. Filters: `action` " +
            "(422 `invalid_action` for unknown values), `envId`, `limit` " +
            "(1–100, 422 `invalid_limit`), `cursor` (422 `invalid_cursor` " +
            "when malformed).",
          tags: ["Audit"],
          responses: {
            200: {
              description:
                "One page of entries plus the cursor for the next page.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      entries: {
                        type: "array",
                        items: {
                          type: "object",
                          description:
                            "Per-action fields (e.g. envId, key, version, " +
                            "userId — keys/ids/counts, never secret " +
                            "values) are flattened onto the entry as " +
                            "additional string properties alongside the " +
                            "fixed ones below.",
                          properties: {
                            id: {
                              type: "string",
                              description:
                                "Stream entry id — usable as a cursor.",
                            },
                            action: { type: "string" },
                            actorType: {
                              type: "string",
                              enum: ["user", "service_token", "system"],
                            },
                            actorId: { type: "string" },
                            ts: { type: "number" },
                          },
                          additionalProperties: { type: "string" },
                        },
                      },
                      nextCursor: {
                        type: "string",
                        nullable: true,
                        description:
                          "Pass back as ?cursor= for the next page; null " +
                          "when there is nothing further.",
                      },
                    },
                  },
                },
              },
            },
            401: { description: "Missing or invalid credentials." },
            403: {
              description: "Service tokens may not read audit trails.",
            },
            404: {
              description:
                "Unknown project — or one the caller is not a member of.",
            },
            422: {
              description:
                "`invalid_limit`, `invalid_action`, or `invalid_cursor`.",
            },
          },
        },
      },
    );
}
