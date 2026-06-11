import type { AuditAction, AuditActorType } from "@secret-gardens/shared";
import type { RedisLike } from "./client";

/**
 * Append-only audit logging on Redis streams.
 *
 *   audit:{projectId}   — per-project stream
 *   audit:instance      — instance-wide stream
 *
 * Appended via XADD (with `MAXLEN ~` when a max length is configured) and read
 * newest-first via XREVRANGE with exclusive `(`-prefixed cursors on entry ids.
 */

export type AuditScope = { projectId: string } | "instance";

export interface AuditAppendEntry {
  action: AuditAction;
  actorType: AuditActorType;
  actorId: string;
  /** Extra context (envId, secretKey, …). Values must be strings. */
  fields: Record<string, string>;
}

export interface AuditEntry {
  [field: string]: string | number;
  id: string;
  /** Milliseconds — derived from the stream entry id. */
  ts: number;
  action: string;
  actorType: string;
  actorId: string;
}

export interface ReadAuditOptions {
  /** Exclusive cursor: the id of the last entry from the previous page. */
  cursor?: string;
  limit?: number;
  action?: AuditAction;
  envId?: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Non-null when another page may exist; pass back as `cursor`. */
  nextCursor: string | null;
}

export interface AuditLog {
  appendAudit(scope: AuditScope, entry: AuditAppendEntry): Promise<string>;
  readAudit(scope: AuditScope, opts?: ReadAuditOptions): Promise<AuditPage>;
}

const RESERVED_FIELDS = new Set(["id", "ts", "action", "actorType", "actorId"]);
const DEFAULT_LIMIT = 50;
const MIN_FETCH_BATCH = 32;
const MAX_FETCH_BATCH = 1024;

function streamKey(scope: AuditScope): string {
  return scope === "instance" ? "audit:instance" : `audit:${scope.projectId}`;
}

export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

function normalizeFields(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === null || raw === undefined) {
    return out;
  }
  if (raw instanceof Map) {
    for (const [key, value] of raw) {
      out[String(key)] = String(value);
    }
    return out;
  }
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      out[String(raw[i])] = String(raw[i + 1]);
    }
    return out;
  }
  if (typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * Normalizes an XRANGE/XREVRANGE reply into a flat list. Bun's RESP3 client
 * may surface stream entries as nested arrays (`[id, [f, v, ...]]`), as Maps,
 * or with object-shaped field payloads — all are handled.
 */
export function normalizeStreamEntries(raw: unknown): StreamEntry[] {
  if (raw === null || raw === undefined) {
    return [];
  }
  if (raw instanceof Map) {
    return [...raw.entries()].map(([id, fields]) => ({
      id: String(id),
      fields: normalizeFields(fields),
    }));
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: StreamEntry[] = [];
  for (const item of raw) {
    if (Array.isArray(item) && item.length >= 2) {
      out.push({ id: String(item[0]), fields: normalizeFields(item[1]) });
    } else if (item instanceof Map) {
      for (const [id, fields] of item) {
        out.push({ id: String(id), fields: normalizeFields(fields) });
      }
    }
  }
  return out;
}

function toAuditEntry(item: StreamEntry): AuditEntry {
  const ts = Number(item.id.split("-")[0] ?? Number.NaN);
  return {
    ...item.fields,
    id: item.id,
    ts,
    action: item.fields.action ?? "",
    actorType: item.fields.actorType ?? "",
    actorId: item.fields.actorId ?? "",
  };
}

export function createAuditLog(
  redis: RedisLike,
  options: { maxLen?: number | null } = {},
): AuditLog {
  const maxLen = options.maxLen ?? null;

  return {
    async appendAudit(scope, entry) {
      const flat: string[] = [
        "action",
        entry.action,
        "actorType",
        entry.actorType,
        "actorId",
        entry.actorId,
      ];
      for (const [key, value] of Object.entries(entry.fields)) {
        if (RESERVED_FIELDS.has(key)) {
          throw new Error(`audit field name "${key}" is reserved`);
        }
        flat.push(key, value);
      }
      const args =
        maxLen === null
          ? [streamKey(scope), "*", ...flat]
          : [streamKey(scope), "MAXLEN", "~", String(maxLen), "*", ...flat];
      const id = await redis.send("XADD", args);
      if (typeof id !== "string") {
        throw new Error(`XADD returned unexpected reply type: ${typeof id}`);
      }
      return id;
    },

    async readAudit(scope, opts = {}) {
      const limit = opts.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("readAudit limit must be a positive integer");
      }
      const key = streamKey(scope);
      let batch = Math.max(limit, MIN_FETCH_BATCH);
      const entries: AuditEntry[] = [];
      let lastSeenId: string | null = opts.cursor ?? null;
      let nextCursor: string | null = null;

      // Filters are applied post-read, so over-fetch until the limit is
      // satisfied or the stream is exhausted.
      outer: while (true) {
        const end = lastSeenId === null ? "+" : `(${lastSeenId}`;
        const raw = await redis.send("XREVRANGE", [
          key,
          end,
          "-",
          "COUNT",
          String(batch),
        ]);
        const page = normalizeStreamEntries(raw);
        const matchedBefore = entries.length;
        for (const item of page) {
          lastSeenId = item.id;
          const entry = toAuditEntry(item);
          if (opts.action !== undefined && entry.action !== opts.action) {
            continue;
          }
          if (opts.envId !== undefined && entry.envId !== opts.envId) {
            continue;
          }
          entries.push(entry);
          if (entries.length >= limit) {
            nextCursor = item.id;
            break outer;
          }
        }
        if (page.length < batch) {
          break; // stream exhausted
        }
        if (entries.length === matchedBefore) {
          // The filters discarded the whole batch — grow geometrically
          // (capped) so sparse matches over a long stream cost O(log n)
          // round trips instead of thousands of fixed-size ones.
          batch = Math.min(batch * 2, MAX_FETCH_BATCH);
        }
      }

      return { entries, nextCursor };
    },
  };
}
