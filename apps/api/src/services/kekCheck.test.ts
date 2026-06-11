import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { generateMasterKey, loadMasterKey } from "@secret-gardens/crypto";
import { openDb, runMigrations } from "../db";
import { ensureKekCheck, KekCheckError } from "./kekCheck";

function readStored(db: Database): string | undefined {
  return db
    .query<{ value: string }, []>(
      "SELECT value FROM instance_settings WHERE key = 'kek_check'",
    )
    .get()?.value;
}

describe("ensureKekCheck", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
    runMigrations(db);
  });

  test("first run writes a packed wrapped check value", () => {
    const mk = loadMasterKey(generateMasterKey());
    ensureKekCheck(db, mk);
    const stored = readStored(db);
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored as string);
    expect(parsed).toMatchObject({ kekId: mk.kekId });
    expect(typeof parsed.wrapped).toBe("string");
    expect(typeof parsed.nonce).toBe("string");
    expect(typeof parsed.tag).toBe("string");
  });

  test("rerun with the same key succeeds and leaves the value unchanged", () => {
    const mk = loadMasterKey(generateMasterKey());
    ensureKekCheck(db, mk);
    const first = readStored(db);
    expect(() => ensureKekCheck(db, mk)).not.toThrow();
    expect(readStored(db)).toBe(first as string);
  });

  test("a different master key aborts with an actionable message", () => {
    ensureKekCheck(db, loadMasterKey(generateMasterKey()));
    const otherKey = loadMasterKey(generateMasterKey());
    expect(() => ensureKekCheck(db, otherKey)).toThrow(KekCheckError);
    expect(() => ensureKekCheck(db, otherKey)).toThrow(
      /GARDENS_MASTER_KEY does not match the key this database was initialized with/,
    );
  });

  test("corrupted stored JSON produces a clear error", () => {
    const mk = loadMasterKey(generateMasterKey());
    db.run(
      "INSERT INTO instance_settings (key, value) VALUES ('kek_check', 'not-json{{')",
    );
    expect(() => ensureKekCheck(db, mk)).toThrow(KekCheckError);
    expect(() => ensureKekCheck(db, mk)).toThrow(/corrupted/);
  });

  test("structurally invalid stored value produces a clear error", () => {
    const mk = loadMasterKey(generateMasterKey());
    db.run(
      `INSERT INTO instance_settings (key, value) VALUES ('kek_check', '{"wrapped":"x","nonce":"y","tag":"z","kekId":"nothex"}')`,
    );
    expect(() => ensureKekCheck(db, mk)).toThrow(KekCheckError);
    expect(() => ensureKekCheck(db, mk)).toThrow(/corrupted/);
  });
});
