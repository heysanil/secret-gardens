import type { Database } from "bun:sqlite";
import {
  CryptoError,
  type MasterKey,
  type PackedWrappedDek,
  packWrappedDek,
  unpackWrappedDek,
  unwrapDek,
  wrapDek,
} from "@secret-gardens/crypto";
import { KEK_CHECK_AAD_ID, KEK_CHECK_SETTINGS_KEY } from "./kekCheck";

/** Thrown when rotation cannot proceed; the transaction has rolled back. */
export class KekRotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KekRotationError";
  }
}

export interface KekRotationResult {
  /** project_keys rows re-wrapped from the old KEK to the new one. */
  rewrapped: number;
  /** Rows already wrapped with the new KEK (a previous, interrupted run). */
  skipped: number;
  /** Whether instance_settings.kek_check was rewritten or already current. */
  kekCheck: "rewritten" | "already-current";
}

interface ProjectKeyRow {
  id: string;
  project_id: string;
  version: number;
  status: string;
  wrapped_dek: string;
  wrap_nonce: string;
  wrap_tag: string;
  kek_id: string;
}

/**
 * Re-wraps every project_keys row (active AND retired — retired versions
 * still decrypt historical secret versions) from `oldKey` to `newKey`, and
 * rewrites the instance_settings kek_check under the new key. Everything
 * runs in ONE SQLite transaction: any row wrapped with a KEK that is
 * neither `oldKey` nor `newKey` — or whose ciphertext fails to unwrap —
 * aborts the whole run as a KekRotationError with no partial state.
 *
 * Rows already wrapped with `newKey` are skipped, so an interrupted run can
 * simply be re-executed.
 *
 * Secrets in Redis are untouched by design: envelope encryption means they
 * are encrypted with per-project DEKs — only the wrapping of those DEKs
 * (and the kek_check) changes here.
 */
export function rotateKek(
  db: Database,
  oldKey: MasterKey,
  newKey: MasterKey,
): KekRotationResult {
  let result: KekRotationResult = {
    rewrapped: 0,
    skipped: 0,
    kekCheck: "already-current",
  };

  const run = db.transaction(() => {
    // Read kek_check inside the transaction: a read taken before BEGIN
    // would not be part of this snapshot and could go stale under races.
    const checkRow = db
      .query<{ value: string }, [string]>(
        "SELECT value FROM instance_settings WHERE key = ?",
      )
      .get(KEK_CHECK_SETTINGS_KEY);
    if (checkRow === null) {
      throw new KekRotationError(
        "instance_settings has no kek_check row — this database has never been " +
          "booted by the secret-gardens API, so there is nothing to rotate.",
      );
    }

    let rewrapped = 0;
    let skipped = 0;

    const rows = db
      .query<ProjectKeyRow, []>(
        `SELECT id, project_id, version, status,
                wrapped_dek, wrap_nonce, wrap_tag, kek_id
         FROM project_keys`,
      )
      .all();

    const update = db.query(
      `UPDATE project_keys
       SET wrapped_dek = ?, wrap_nonce = ?, wrap_tag = ?, kek_id = ?
       WHERE id = ?`,
    );

    for (const row of rows) {
      if (row.kek_id === newKey.kekId) {
        skipped += 1;
        continue;
      }
      if (row.kek_id !== oldKey.kekId) {
        throw new KekRotationError(
          `project_keys row ${row.id} (project ${row.project_id}, ` +
            `version ${row.version}, ${row.status}) is wrapped with KEK ` +
            `${row.kek_id}, which matches neither the current key ` +
            `(${oldKey.kekId}) nor the new key (${newKey.kekId}). ` +
            "Aborting with no changes.",
        );
      }
      let dek: Buffer;
      try {
        dek = unwrapDek(
          oldKey,
          unpackWrappedDek({
            wrapped: row.wrapped_dek,
            nonce: row.wrap_nonce,
            tag: row.wrap_tag,
            kekId: row.kek_id,
          }),
          row.project_id,
        );
      } catch (err) {
        if (err instanceof CryptoError) {
          throw new KekRotationError(
            `project_keys row ${row.id} (project ${row.project_id}, ` +
              `version ${row.version}, ${row.status}) failed to unwrap with ` +
              "the current key — the stored ciphertext may be corrupted. " +
              `Aborting with no changes. (${err.message})`,
          );
        }
        throw err;
      }
      const packed = packWrappedDek(wrapDek(newKey, dek, row.project_id));
      dek.fill(0); // Never cached here — safe to zero after re-wrapping.
      update.run(
        packed.wrapped,
        packed.nonce,
        packed.tag,
        packed.kekId,
        row.id,
      );
      rewrapped += 1;
    }

    // kek_check: same neither-key abort, same skip-if-already-new logic.
    let packedCheck: PackedWrappedDek;
    try {
      packedCheck = JSON.parse(checkRow.value) as PackedWrappedDek;
    } catch (err) {
      throw new KekRotationError(
        "instance_settings kek_check cannot be parsed — the database may be " +
          `damaged. Aborting with no changes. (${(err as Error).message})`,
      );
    }
    let kekCheck: KekRotationResult["kekCheck"] = "already-current";
    if (packedCheck.kekId !== newKey.kekId) {
      if (packedCheck.kekId !== oldKey.kekId) {
        throw new KekRotationError(
          `instance_settings kek_check is wrapped with KEK ${packedCheck.kekId}, ` +
            `which matches neither the current key (${oldKey.kekId}) nor the ` +
            `new key (${newKey.kekId}). Aborting with no changes.`,
        );
      }
      let constant: Buffer;
      try {
        constant = unwrapDek(
          oldKey,
          unpackWrappedDek(packedCheck),
          KEK_CHECK_AAD_ID,
        );
      } catch (err) {
        if (err instanceof CryptoError) {
          throw new KekRotationError(
            "instance_settings kek_check failed to unwrap with the current " +
              "key — the stored value may be corrupted. Aborting with no " +
              `changes. (${err.message})`,
          );
        }
        throw err;
      }
      const rewrapping = packWrappedDek(
        wrapDek(newKey, constant, KEK_CHECK_AAD_ID),
      );
      constant.fill(0);
      db.run("UPDATE instance_settings SET value = ? WHERE key = ?", [
        JSON.stringify(rewrapping),
        KEK_CHECK_SETTINGS_KEY,
      ]);
      kekCheck = "rewritten";
    }

    result = { rewrapped, skipped, kekCheck };
  });
  run();

  return result;
}
