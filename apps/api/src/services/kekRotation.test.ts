import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  generateDek,
  generateMasterKey,
  loadMasterKey,
  packWrappedDek,
  wrapDek,
} from "@safe/crypto";
import { newId, openDb, runMigrations } from "../db";
import { createDekService } from "./dekService";
import {
  ensureKekCheck,
  KEK_CHECK_SETTINGS_KEY,
  KekCheckError,
} from "./kekCheck";
import { KekRotationError, rotateKek } from "./kekRotation";

const oldKey = loadMasterKey(generateMasterKey());
const newKey = loadMasterKey(generateMasterKey());

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  ensureKekCheck(db, oldKey);
});

afterEach(() => {
  db.close();
});

function insertProject(projectId: string): void {
  db.run(
    "INSERT INTO projects (id, name, slug, created_by, created_at, updated_at) VALUES (?, ?, ?, 'usr_t', 1, 1)",
    [projectId, "Test", projectId],
  );
}

interface KeyRow {
  id: string;
  project_id: string;
  version: number;
  status: string;
  kek_id: string;
}

function allKeyRows(): KeyRow[] {
  return db
    .query<KeyRow, []>(
      "SELECT id, project_id, version, status, kek_id FROM project_keys ORDER BY project_id, version",
    )
    .all();
}

/** Every column of every row — for byte-exact rollback assertions. */
function fullKeyRows(): Record<string, unknown>[] {
  return db
    .query<Record<string, unknown>, []>(
      "SELECT * FROM project_keys ORDER BY project_id, version",
    )
    .all();
}

function kekCheckValue(): string {
  const row = db
    .query<{ value: string }, [string]>(
      "SELECT value FROM instance_settings WHERE key = ?",
    )
    .get(KEK_CHECK_SETTINGS_KEY);
  if (row === null) {
    throw new Error("kek_check row missing");
  }
  return row.value;
}

/** Seeds two projects under oldKey; project B has a retired v1 + active v2. */
function seedProjects(): { dekA: Buffer; dekB1: Buffer; dekB2: Buffer } {
  const service = createDekService({ db, masterKey: oldKey });
  insertProject("prj_a");
  insertProject("prj_b");
  const dekA = Buffer.from(service.createProjectDek("prj_a").dek);
  const dekB1 = Buffer.from(service.createProjectDek("prj_b").dek);
  const dekB2 = Buffer.from(service.rotateDek("prj_b").dek);
  return { dekA, dekB1, dekB2 };
}

describe("rotateKek", () => {
  test("re-wraps every row (active and retired) and rewrites kek_check", () => {
    seedProjects();
    const before = kekCheckValue();

    const result = rotateKek(db, oldKey, newKey);

    expect(result).toEqual({ rewrapped: 3, skipped: 0, kekCheck: "rewritten" });
    const rows = allKeyRows();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.kek_id).toBe(newKey.kekId);
    }
    expect(kekCheckValue()).not.toBe(before);
  });

  test("DEKs unwrap to identical bytes under the new master key", () => {
    const { dekA, dekB1, dekB2 } = seedProjects();

    rotateKek(db, oldKey, newKey);

    const after = createDekService({ db, masterKey: newKey });
    expect(after.getDek("prj_a").dek.equals(dekA)).toBe(true);
    expect(after.getDekVersion("prj_b", 1).dek.equals(dekB1)).toBe(true);
    expect(after.getDek("prj_b").dek.equals(dekB2)).toBe(true);
  });

  test("the old master key no longer unwraps anything after rotation", () => {
    seedProjects();
    rotateKek(db, oldKey, newKey);

    const stale = createDekService({ db, masterKey: oldKey });
    expect(() => stale.getDek("prj_a")).toThrow();
    // Boot check now rejects the old key and accepts the new one.
    expect(() => ensureKekCheck(db, oldKey)).toThrow(KekCheckError);
    expect(() => ensureKekCheck(db, newKey)).not.toThrow();
  });

  test("is idempotent: a second run skips everything", () => {
    seedProjects();
    rotateKek(db, oldKey, newKey);

    const second = rotateKek(db, newKey, newKey);
    expect(second).toEqual({
      rewrapped: 0,
      skipped: 3,
      kekCheck: "already-current",
    });
  });

  test("resumes an interrupted rotation: new-key rows are skipped, old-key rows re-wrapped", () => {
    seedProjects();
    // Simulate a partially rotated state: prj_a already under the new key.
    const halfDone = createDekService({ db, masterKey: oldKey });
    const dekA = halfDone.getDek("prj_a").dek;
    const packed = packWrappedDek(wrapDek(newKey, dekA, "prj_a"));
    db.run(
      `UPDATE project_keys SET wrapped_dek = ?, wrap_nonce = ?, wrap_tag = ?, kek_id = ?
       WHERE project_id = 'prj_a'`,
      [packed.wrapped, packed.nonce, packed.tag, packed.kekId],
    );

    const result = rotateKek(db, oldKey, newKey);
    expect(result).toEqual({ rewrapped: 2, skipped: 1, kekCheck: "rewritten" });
    for (const row of allKeyRows()) {
      expect(row.kek_id).toBe(newKey.kekId);
    }
  });

  test("aborts with no changes when a row is wrapped with a foreign KEK", () => {
    seedProjects();
    const foreignKey = loadMasterKey(generateMasterKey());
    insertProject("prj_c");
    const packed = packWrappedDek(wrapDek(foreignKey, generateDek(), "prj_c"));
    db.run(
      `INSERT INTO project_keys
         (id, project_id, version, wrapped_dek, wrap_nonce, wrap_tag, kek_id, status)
       VALUES (?, 'prj_c', 1, ?, ?, ?, ?, 'active')`,
      [newId("pk"), packed.wrapped, packed.nonce, packed.tag, packed.kekId],
    );
    const rowsBefore = allKeyRows();
    const checkBefore = kekCheckValue();

    expect(() => rotateKek(db, oldKey, newKey)).toThrow(KekRotationError);

    // Transaction rolled back: nothing changed, no partial state.
    expect(allKeyRows()).toEqual(rowsBefore);
    expect(kekCheckValue()).toBe(checkBefore);
    expect(() => ensureKekCheck(db, oldKey)).not.toThrow();
  });

  test("corrupted row ciphertext aborts as KekRotationError with full rollback", () => {
    seedProjects();
    // Corrupt prj_b v1's auth tag while keeping its kek_id intact: the
    // unwrap fails (DekUnwrapError) rather than the kek_id pre-check.
    db.run(
      "UPDATE project_keys SET wrap_tag = ? WHERE project_id = 'prj_b' AND version = 1",
      [Buffer.alloc(16).toString("base64")],
    );
    const rowsBefore = fullKeyRows();
    const checkBefore = kekCheckValue();

    // The controlled error type — never a raw DekUnwrapError stack.
    expect(() => rotateKek(db, oldKey, newKey)).toThrow(KekRotationError);
    expect(() => rotateKek(db, oldKey, newKey)).toThrow(/corrupted/);

    // Transaction rolled back: every row (including any processed before
    // the corrupted one) is byte-identical, kek_check untouched.
    expect(fullKeyRows()).toEqual(rowsBefore);
    expect(kekCheckValue()).toBe(checkBefore);
  });

  test("corrupted kek_check aborts as KekRotationError with full rollback", () => {
    seedProjects();
    db.run("UPDATE instance_settings SET value = ? WHERE key = ?", [
      "{not json",
      KEK_CHECK_SETTINGS_KEY,
    ]);
    const rowsBefore = fullKeyRows();

    expect(() => rotateKek(db, oldKey, newKey)).toThrow(KekRotationError);
    expect(fullKeyRows()).toEqual(rowsBefore);
  });

  test("refuses to run against a database that was never booted", () => {
    db.run("DELETE FROM instance_settings WHERE key = ?", [
      KEK_CHECK_SETTINGS_KEY,
    ]);
    expect(() => rotateKek(db, oldKey, newKey)).toThrow(KekRotationError);
  });
});
