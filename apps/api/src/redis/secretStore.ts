import type { AuditActorType } from "@safe/shared";
import type { RedisLike } from "./client";

/**
 * Redis storage for encrypted secrets. This layer is crypto-agnostic: it
 * stores opaque, pre-packed ciphertext records and never sees plaintext or
 * DEKs.
 *
 * Key design (per the design spec):
 *   secrets:{projectId}:{envId}              HASH field=KEY → current JSON
 *   secretver:{projectId}:{envId}:{key}      HASH field=version → version JSON
 *   secretvctr:{projectId}:{envId}:{key}     gap-free version counter (INCR)
 *
 * ATOMICITY: every write path is a single Lua script (EVAL). MULTI/EXEC is
 * deliberately avoided — Bun's RedisClient shares one auto-pipelined
 * connection, so interleaved transactions from concurrent requests would
 * corrupt each other. The version number is allocated by INCR *inside* the
 * script and injected into the current-value JSON via Lua's built-in cjson
 * (decode → set `v` → encode), which avoids fragile string templating.
 * cjson's 14-significant-digit number formatting is safe here: ms timestamps
 * are 13 digits until the year 2286 and versions/dekV are small integers.
 */

export type SecretOp = "create" | "update" | "delete" | "rollback";
export type SecretWriteOp = Exclude<SecretOp, "delete">;

export interface SecretActor {
  type: AuditActorType;
  id: string;
}

/** Opaque packed ciphertext produced upstream (Phase 5 secretService). */
export interface SecretCipherPayload {
  ct: string;
  nonce: string;
  tag: string;
  dekV: number;
  alg: string;
}

export interface CurrentSecret extends SecretCipherPayload {
  v: number;
  updatedAt: number;
  updatedBy: string;
}

/** Append-only version record; tombstones omit the ciphertext fields. */
export interface SecretVersion {
  ct?: string;
  nonce?: string;
  tag?: string;
  dekV?: number;
  alg?: string;
  op: SecretOp;
  actorType: AuditActorType;
  actorId: string;
  ts: number;
  rollbackOf?: number;
}

export interface SecretVersionMeta {
  version: number;
  op: SecretOp;
  actorType: AuditActorType;
  actorId: string;
  ts: number;
  rollbackOf?: number;
  hasValue: boolean;
}

/** A version number paired with its full stored record. */
export interface VersionRecord {
  version: number;
  record: SecretVersion;
}

const secretsKey = (projectId: string, envId: string) =>
  `secrets:${projectId}:${envId}`;
const versionsKey = (projectId: string, envId: string, key: string) =>
  `secretver:${projectId}:${envId}:${key}`;
const counterKey = (projectId: string, envId: string, key: string) =>
  `secretvctr:${projectId}:${envId}:${key}`;

/**
 * KEYS = [counter, versions hash, current hash]
 * ARGV = [secret key (field), version JSON (no v), current JSON (no v)]
 * The version number lives only in the version-hash field name and in the
 * current JSON's `v`, set via cjson inside the script.
 */
const WRITE_SCRIPT = `
local v = redis.call('INCR', KEYS[1])
redis.call('HSET', KEYS[2], tostring(v), ARGV[2])
local cur = cjson.decode(ARGV[3])
cur.v = v
redis.call('HSET', KEYS[3], ARGV[1], cjson.encode(cur))
return v
`;

/**
 * KEYS = [counter, versions hash, current hash]
 * ARGV = [secret key (field), tombstone version JSON]
 * Returns 0 (→ null) when the key has no current value.
 */
const DELETE_SCRIPT = `
if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 0 then
  return 0
end
local v = redis.call('INCR', KEYS[1])
redis.call('HSET', KEYS[2], tostring(v), ARGV[2])
redis.call('HDEL', KEYS[3], ARGV[1])
return v
`;

/**
 * KEYS = [current hash]
 * ARGV = [secret key (field), cipher payload JSON]
 * Replaces ONLY the ciphertext fields of the current record, preserving
 * `v`/`updatedAt`/`updatedBy` — no version append, no counter touch.
 * Returns 0 (→ false) when the key has no current value.
 */
const REWRITE_CURRENT_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return 0
end
local cur = cjson.decode(raw)
local p = cjson.decode(ARGV[2])
cur.ct = p.ct
cur.nonce = p.nonce
cur.tag = p.tag
cur.dekV = p.dekV
cur.alg = p.alg
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(cur))
return 1
`;

const SCAN_BATCH = "1000";
const UNLINK_BATCH = 500;

export interface SecretStore {
  writeSecret(
    projectId: string,
    envId: string,
    key: string,
    payload: SecretCipherPayload,
    actor: SecretActor,
    op: SecretWriteOp,
    rollbackOf?: number,
  ): Promise<number>;
  deleteSecret(
    projectId: string,
    envId: string,
    key: string,
    actor: SecretActor,
  ): Promise<number | null>;
  /**
   * In-place ciphertext replacement of the CURRENT record only — same `v`,
   * same `updatedAt`/`updatedBy`, no version-history append. Used ONLY by
   * DEK rotation, which re-encrypts existing plaintext under a new DEK;
   * anything that changes the plaintext must go through writeSecret.
   * Returns false when the key has no current value.
   */
  rewriteCurrent(
    projectId: string,
    envId: string,
    key: string,
    payload: SecretCipherPayload,
  ): Promise<boolean>;
  getCurrent(
    projectId: string,
    envId: string,
    key: string,
  ): Promise<CurrentSecret | null>;
  getAllCurrent(
    projectId: string,
    envId: string,
  ): Promise<Record<string, CurrentSecret>>;
  listKeys(projectId: string, envId: string): Promise<string[]>;
  /** Metadata-only view over listVersionRecords (same single HGETALL). */
  listVersions(
    projectId: string,
    envId: string,
    key: string,
  ): Promise<SecretVersionMeta[]>;
  /**
   * Every version's full record (ciphertext included) from ONE HGETALL,
   * newest first — the include_values read path consumes this instead of
   * re-fetching versions one by one.
   */
  listVersionRecords(
    projectId: string,
    envId: string,
    key: string,
  ): Promise<VersionRecord[]>;
  getVersion(
    projectId: string,
    envId: string,
    key: string,
    version: number,
  ): Promise<SecretVersion | null>;
  deleteEnvironmentData(projectId: string, envId: string): Promise<void>;
  deleteProjectData(projectId: string): Promise<void>;
}

export function createSecretStore(redis: RedisLike): SecretStore {
  async function eval3(
    script: string,
    projectId: string,
    envId: string,
    key: string,
    argv: string[],
  ): Promise<number> {
    const result = await redis.send("EVAL", [
      script,
      "3",
      counterKey(projectId, envId, key),
      versionsKey(projectId, envId, key),
      secretsKey(projectId, envId),
      key,
      ...argv,
    ]);
    if (typeof result !== "number") {
      throw new Error(
        `secretStore script returned unexpected reply type: ${typeof result}`,
      );
    }
    return result;
  }

  async function scanKeys(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = "0";
    do {
      const reply = (await redis.send("SCAN", [
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        SCAN_BATCH,
      ])) as [string, string[]];
      cursor = reply[0];
      found.push(...reply[1]);
    } while (cursor !== "0");
    return found;
  }

  async function unlinkAll(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += UNLINK_BATCH) {
      const batch = keys.slice(i, i + UNLINK_BATCH);
      if (batch.length > 0) {
        await redis.send("UNLINK", batch);
      }
    }
  }

  async function deleteByPatterns(patterns: string[]): Promise<void> {
    for (const pattern of patterns) {
      await unlinkAll(await scanKeys(pattern));
    }
  }

  async function listVersionRecords(
    projectId: string,
    envId: string,
    key: string,
  ): Promise<VersionRecord[]> {
    const raw = (await redis.hgetall(versionsKey(projectId, envId, key))) ?? {};
    const records: VersionRecord[] = Object.entries(raw).map(
      ([field, value]) => ({
        version: Number(field),
        record: JSON.parse(value) as SecretVersion,
      }),
    );
    records.sort((a, b) => b.version - a.version);
    return records;
  }

  return {
    async writeSecret(projectId, envId, key, payload, actor, op, rollbackOf) {
      const ts = Date.now();
      const version: SecretVersion = {
        ct: payload.ct,
        nonce: payload.nonce,
        tag: payload.tag,
        dekV: payload.dekV,
        alg: payload.alg,
        op,
        actorType: actor.type,
        actorId: actor.id,
        ts,
      };
      if (rollbackOf !== undefined) {
        version.rollbackOf = rollbackOf;
      }
      const current: Omit<CurrentSecret, "v"> = {
        ct: payload.ct,
        nonce: payload.nonce,
        tag: payload.tag,
        dekV: payload.dekV,
        alg: payload.alg,
        updatedAt: ts,
        updatedBy: actor.id,
      };
      return eval3(WRITE_SCRIPT, projectId, envId, key, [
        JSON.stringify(version),
        JSON.stringify(current),
      ]);
    },

    async deleteSecret(projectId, envId, key, actor) {
      const tombstone: SecretVersion = {
        op: "delete",
        actorType: actor.type,
        actorId: actor.id,
        ts: Date.now(),
      };
      const version = await eval3(DELETE_SCRIPT, projectId, envId, key, [
        JSON.stringify(tombstone),
      ]);
      return version === 0 ? null : version;
    },

    async rewriteCurrent(projectId, envId, key, payload) {
      const result = await redis.send("EVAL", [
        REWRITE_CURRENT_SCRIPT,
        "1",
        secretsKey(projectId, envId),
        key,
        JSON.stringify(payload),
      ]);
      if (typeof result !== "number") {
        throw new Error(
          `secretStore script returned unexpected reply type: ${typeof result}`,
        );
      }
      return result === 1;
    },

    async getCurrent(projectId, envId, key) {
      const raw = await redis.hget(secretsKey(projectId, envId), key);
      return raw === null ? null : (JSON.parse(raw) as CurrentSecret);
    },

    async getAllCurrent(projectId, envId) {
      const raw = (await redis.hgetall(secretsKey(projectId, envId))) ?? {};
      const result: Record<string, CurrentSecret> = {};
      for (const [key, value] of Object.entries(raw)) {
        result[key] = JSON.parse(value) as CurrentSecret;
      }
      return result;
    },

    async listKeys(projectId, envId) {
      return (await redis.hkeys(secretsKey(projectId, envId))) ?? [];
    },

    listVersionRecords,

    async listVersions(projectId, envId, key) {
      const records = await listVersionRecords(projectId, envId, key);
      return records.map(({ version, record }) => {
        const meta: SecretVersionMeta = {
          version,
          op: record.op,
          actorType: record.actorType,
          actorId: record.actorId,
          ts: record.ts,
          hasValue: record.ct !== undefined,
        };
        if (record.rollbackOf !== undefined) {
          meta.rollbackOf = record.rollbackOf;
        }
        return meta;
      });
    },

    async getVersion(projectId, envId, key, version) {
      const raw = await redis.hget(
        versionsKey(projectId, envId, key),
        String(version),
      );
      return raw === null ? null : (JSON.parse(raw) as SecretVersion);
    },

    async deleteEnvironmentData(projectId, envId) {
      // Secret keys match ^[A-Za-z_][A-Za-z0-9_]*$ and ids are colon-free, so
      // these MATCH patterns cannot collide across environments or projects.
      await deleteByPatterns([
        secretsKey(projectId, envId),
        `secretver:${projectId}:${envId}:*`,
        `secretvctr:${projectId}:${envId}:*`,
      ]);
    },

    async deleteProjectData(projectId) {
      await deleteByPatterns([
        `secrets:${projectId}:*`,
        `secretver:${projectId}:*`,
        `secretvctr:${projectId}:*`,
      ]);
    },
  };
}
