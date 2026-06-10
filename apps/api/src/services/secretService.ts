import {
  decryptSecret,
  encryptSecret,
  packEncrypted,
  type SecretAad,
  unpackEncrypted,
} from "@safe/crypto";
import type {
  CurrentSecret,
  SecretActor,
  SecretCipherPayload,
  SecretOp,
  SecretStore,
  SecretWriteOp,
} from "../redis/secretStore";
import type { DekService } from "./dekService";

/**
 * The encryption boundary: everything below this service sees only opaque
 * ciphertext; everything above it sees only plaintext. AAD binds each
 * ciphertext to {projectId, envId, secretKey} (ids, never slugs — renames
 * stay safe), and deliberately excludes the version number so rollback can
 * re-point an old ciphertext as a new version.
 */

const ALG = "aes-256-gcm:v1";

/**
 * Any failure to decrypt a stored record (GCM auth failure, unknown DEK
 * version, corrupted packing). Routes map it to 500 {error:'decrypt_failed'}.
 * Messages identify the record by location only — never plaintext or key
 * material.
 */
export class DecryptFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptFailedError";
  }
}

export interface SecretServiceDeps {
  dekService: DekService;
  secretStore: SecretStore;
}

export interface ChangedSecret {
  key: string;
  version: number;
}

export interface BulkResult {
  created: ChangedSecret[];
  updated: ChangedSecret[];
  deleted: ChangedSecret[];
  unchanged: number;
}

export interface SecretEntry {
  key: string;
  version: number;
  updatedAt: number;
  updatedBy: string;
  value?: string;
}

export interface SecretVersionEntry {
  version: number;
  op: SecretOp;
  actorType: SecretActor["type"];
  actorId: string;
  ts: number;
  rollbackOf?: number;
  hasValue: boolean;
  value?: string;
}

export type RollbackResult =
  | { ok: true; version: number }
  | { ok: false; reason: "not_found" | "tombstone" };

export interface RotationResult {
  oldVersion: number;
  newVersion: number;
  secretsRewritten: number;
}

export interface SecretService {
  setSecret(
    projectId: string,
    envId: string,
    key: string,
    plaintext: string,
    actor: SecretActor,
  ): Promise<{ version: number; op: SecretWriteOp }>;
  /**
   * Bulk upsert with decrypt-compare semantics: keys whose current value
   * already equals the incoming plaintext are left untouched (no version).
   * With prune, current keys absent from the payload are tombstoned.
   */
  setSecrets(
    projectId: string,
    envId: string,
    secrets: Record<string, string>,
    opts: { prune?: boolean; actor: SecretActor },
  ): Promise<BulkResult>;
  getSecrets(
    projectId: string,
    envId: string,
    opts: { includeValues?: boolean },
  ): Promise<SecretEntry[]>;
  getSecretVersions(
    projectId: string,
    envId: string,
    key: string,
    opts: { includeValues?: boolean },
  ): Promise<SecretVersionEntry[]>;
  /** Tombstones the key; null when it has no current value. */
  deleteSecret(
    projectId: string,
    envId: string,
    key: string,
    actor: SecretActor,
  ): Promise<number | null>;
  /**
   * Appends the target version's ciphertext verbatim as a new version
   * (op 'rollback'). dekV is preserved, so targets written under a retired
   * DEK stay decryptable; AAD excludes the version, so the old ciphertext
   * remains valid at its new position.
   */
  rollback(
    projectId: string,
    envId: string,
    key: string,
    toVersion: number,
    actor: SecretActor,
  ): Promise<RollbackResult>;
  /**
   * Rotates the project DEK, then re-encrypts every current secret in the
   * given environments under the new DEK via rewriteCurrent (no version
   * history growth; historical versions keep their old dekV and decrypt via
   * the retired key rows).
   *
   * Not atomic: a decrypt failure aborts mid-way, but every secret rewritten
   * up to that point is valid, and untouched records still decrypt through
   * their recorded dekV — no data is lost in any partial state.
   */
  rotateProjectSecrets(
    projectId: string,
    envIds: string[],
  ): Promise<RotationResult>;
}

interface CipherRecord {
  ct: string;
  nonce: string;
  tag: string;
  dekV: number;
}

export function createSecretService(deps: SecretServiceDeps): SecretService {
  const { dekService, secretStore } = deps;

  function aadFor(projectId: string, envId: string, key: string): SecretAad {
    return { projectId, envId, secretKey: key };
  }

  /** Decrypts a stored record; every failure mode → DecryptFailedError. */
  function decryptRecord(
    projectId: string,
    envId: string,
    key: string,
    record: CipherRecord,
  ): string {
    try {
      const { dek } = dekService.getDekVersion(projectId, record.dekV);
      return decryptSecret(
        dek,
        unpackEncrypted(record),
        aadFor(projectId, envId, key),
      );
    } catch {
      // Deliberately drops the cause: upstream errors could theoretically
      // embed sensitive material; the location triple is enough to debug.
      throw new DecryptFailedError(
        `failed to decrypt secret "${key}" (env ${envId}, dek v${record.dekV})`,
      );
    }
  }

  function encryptToPayload(
    projectId: string,
    envId: string,
    key: string,
    plaintext: string,
  ): SecretCipherPayload {
    const { dek, version: dekV } = dekService.getDek(projectId);
    const enc = encryptSecret(dek, plaintext, aadFor(projectId, envId, key));
    return { ...packEncrypted(enc), dekV, alg: ALG };
  }

  async function writePlaintext(
    projectId: string,
    envId: string,
    key: string,
    plaintext: string,
    actor: SecretActor,
    op: SecretWriteOp,
  ): Promise<number> {
    const payload = encryptToPayload(projectId, envId, key, plaintext);
    return secretStore.writeSecret(projectId, envId, key, payload, actor, op);
  }

  return {
    async setSecret(projectId, envId, key, plaintext, actor) {
      const current = await secretStore.getCurrent(projectId, envId, key);
      const op: SecretWriteOp = current === null ? "create" : "update";
      const version = await writePlaintext(
        projectId,
        envId,
        key,
        plaintext,
        actor,
        op,
      );
      return { version, op };
    },

    async setSecrets(projectId, envId, secrets, { prune = false, actor }) {
      const currentAll = await secretStore.getAllCurrent(projectId, envId);
      const result: BulkResult = {
        created: [],
        updated: [],
        deleted: [],
        unchanged: 0,
      };

      for (const key of Object.keys(secrets).sort()) {
        const plaintext = secrets[key] as string;
        const current = currentAll[key];
        if (current !== undefined) {
          const existing = decryptRecord(projectId, envId, key, current);
          if (existing === plaintext) {
            result.unchanged += 1;
            continue;
          }
          const version = await writePlaintext(
            projectId,
            envId,
            key,
            plaintext,
            actor,
            "update",
          );
          result.updated.push({ key, version });
        } else {
          const version = await writePlaintext(
            projectId,
            envId,
            key,
            plaintext,
            actor,
            "create",
          );
          result.created.push({ key, version });
        }
      }

      if (prune) {
        for (const key of Object.keys(currentAll).sort()) {
          if (key in secrets) {
            continue;
          }
          const version = await secretStore.deleteSecret(
            projectId,
            envId,
            key,
            actor,
          );
          if (version !== null) {
            result.deleted.push({ key, version });
          }
        }
      }

      return result;
    },

    async getSecrets(projectId, envId, { includeValues = false }) {
      const currentAll = await secretStore.getAllCurrent(projectId, envId);
      const entries: SecretEntry[] = [];
      for (const key of Object.keys(currentAll).sort()) {
        const record = currentAll[key] as CurrentSecret;
        const entry: SecretEntry = {
          key,
          version: record.v,
          updatedAt: record.updatedAt,
          updatedBy: record.updatedBy,
        };
        if (includeValues) {
          entry.value = decryptRecord(projectId, envId, key, record);
        }
        entries.push(entry);
      }
      return entries;
    },

    async getSecretVersions(projectId, envId, key, { includeValues = false }) {
      const metas = await secretStore.listVersions(projectId, envId, key);
      const entries: SecretVersionEntry[] = [];
      for (const meta of metas) {
        const entry: SecretVersionEntry = { ...meta };
        if (includeValues && meta.hasValue) {
          const record = await secretStore.getVersion(
            projectId,
            envId,
            key,
            meta.version,
          );
          if (record?.ct !== undefined) {
            entry.value = decryptRecord(
              projectId,
              envId,
              key,
              record as CipherRecord,
            );
          }
        }
        entries.push(entry);
      }
      return entries;
    },

    async deleteSecret(projectId, envId, key, actor) {
      return secretStore.deleteSecret(projectId, envId, key, actor);
    },

    async rollback(projectId, envId, key, toVersion, actor) {
      const target = await secretStore.getVersion(
        projectId,
        envId,
        key,
        toVersion,
      );
      if (target === null) {
        return { ok: false, reason: "not_found" };
      }
      if (target.ct === undefined) {
        return { ok: false, reason: "tombstone" };
      }
      // Ciphertext copied verbatim: same ct/nonce/tag/dekV/alg. No
      // re-encryption — the bytes were already authenticated under this AAD.
      const payload: SecretCipherPayload = {
        ct: target.ct,
        nonce: target.nonce as string,
        tag: target.tag as string,
        dekV: target.dekV as number,
        alg: target.alg as string,
      };
      const version = await secretStore.writeSecret(
        projectId,
        envId,
        key,
        payload,
        actor,
        "rollback",
        toVersion,
      );
      return { ok: true, version };
    },

    async rotateProjectSecrets(projectId, envIds) {
      const { oldVersion, newVersion, dek } = dekService.rotateDek(projectId);
      let secretsRewritten = 0;
      for (const envId of envIds) {
        const currentAll = await secretStore.getAllCurrent(projectId, envId);
        for (const key of Object.keys(currentAll).sort()) {
          const record = currentAll[key] as CurrentSecret;
          // Old records decrypt via their recorded dekV (now retired).
          const plaintext = decryptRecord(projectId, envId, key, record);
          const enc = encryptSecret(
            dek,
            plaintext,
            aadFor(projectId, envId, key),
          );
          const rewritten = await secretStore.rewriteCurrent(
            projectId,
            envId,
            key,
            { ...packEncrypted(enc), dekV: newVersion, alg: ALG },
          );
          if (rewritten) {
            secretsRewritten += 1;
          }
        }
      }
      return { oldVersion, newVersion, secretsRewritten };
    },
  };
}
