import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  generateMasterKey,
  loadMasterKey,
  type PackedWrappedDek,
  unpackWrappedDek,
  unwrapDek,
} from "@safe/crypto";
import { newId, openDb, runMigrations } from "../db";
import {
  createDekService,
  type DekService,
  ProjectKeyNotFoundError,
} from "./dekService";

const masterKey = loadMasterKey(generateMasterKey());

let db: Database;
let service: DekService;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  service = createDekService({ db, masterKey });
});

afterEach(() => {
  db.close();
});

interface ProjectKeyRow {
  version: number;
  wrapped_dek: string;
  wrap_nonce: string;
  wrap_tag: string;
  kek_id: string;
  status: string;
}

function insertProject(projectId: string): void {
  db.run(
    "INSERT INTO projects (id, name, slug, created_by, created_at, updated_at) VALUES (?, ?, ?, 'usr_t', 1, 1)",
    [projectId, "Test", projectId],
  );
}

function keyRows(projectId: string): ProjectKeyRow[] {
  return db
    .query<ProjectKeyRow, [string]>(
      `SELECT version, wrapped_dek, wrap_nonce, wrap_tag, kek_id, status
       FROM project_keys WHERE project_id = ? ORDER BY version`,
    )
    .all(projectId);
}

describe("createProjectDek", () => {
  test("inserts an active v1 row whose wrapped DEK unwraps to the returned DEK", () => {
    const projectId = newId("prj");
    insertProject(projectId);
    const created = service.createProjectDek(projectId);
    expect(created.version).toBe(1);
    expect(created.dek.length).toBe(32);

    const rows = keyRows(projectId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("missing row");
    expect(row.version).toBe(1);
    expect(row.status).toBe("active");
    expect(row.kek_id).toBe(masterKey.kekId);

    const packed: PackedWrappedDek = {
      wrapped: row.wrapped_dek,
      nonce: row.wrap_nonce,
      tag: row.wrap_tag,
      kekId: row.kek_id,
    };
    const unwrapped = unwrapDek(masterKey, unpackWrappedDek(packed), projectId);
    expect(unwrapped.equals(created.dek)).toBe(true);
  });
});

describe("getDek", () => {
  test("returns the active DEK and caches it (later row tampering is not seen)", () => {
    const projectId = newId("prj");
    insertProject(projectId);
    const created = service.createProjectDek(projectId);

    const first = service.getDek(projectId);
    expect(first.version).toBe(1);
    expect(first.dek.equals(created.dek)).toBe(true);

    // Cache: corrupting the row must not affect subsequent reads.
    db.run("UPDATE project_keys SET wrap_tag = ? WHERE project_id = ?", [
      Buffer.alloc(16, 9).toString("base64"),
      projectId,
    ]);
    const second = service.getDek(projectId);
    expect(second.dek.equals(created.dek)).toBe(true);
  });

  test("cached buffers are never zeroed between reads", () => {
    const projectId = newId("prj");
    insertProject(projectId);
    service.createProjectDek(projectId);
    const a = service.getDek(projectId).dek;
    const b = service.getDek(projectId).dek;
    expect(a.equals(b)).toBe(true);
    expect(a.every((byte) => byte === 0)).toBe(false);
  });

  test("throws ProjectKeyNotFoundError for a project with no key", () => {
    expect(() => service.getDek("prj_missing")).toThrow(
      ProjectKeyNotFoundError,
    );
  });
});

describe("rotateDek", () => {
  test("retires v1, activates v2, and returns the new DEK", () => {
    const projectId = newId("prj");
    insertProject(projectId);
    const v1 = service.createProjectDek(projectId);

    const rotated = service.rotateDek(projectId);
    expect(rotated.oldVersion).toBe(1);
    expect(rotated.newVersion).toBe(2);
    expect(rotated.dek.equals(v1.dek)).toBe(false);

    const rows = keyRows(projectId);
    expect(rows.map((r) => [r.version, r.status])).toEqual([
      [1, "retired"],
      [2, "active"],
    ]);

    // Cache was re-primed: getDek serves v2 immediately.
    const active = service.getDek(projectId);
    expect(active.version).toBe(2);
    expect(active.dek.equals(rotated.dek)).toBe(true);
  });

  test("retired versions stay readable via getDekVersion", () => {
    const projectId = newId("prj");
    insertProject(projectId);
    const v1 = service.createProjectDek(projectId);
    service.rotateDek(projectId);

    const old = service.getDekVersion(projectId, 1);
    expect(old.version).toBe(1);
    expect(old.dek.equals(v1.dek)).toBe(true);
  });

  test("repeated rotation increments versions 2, 3", () => {
    const projectId = newId("prj");
    insertProject(projectId);
    service.createProjectDek(projectId);
    expect(service.rotateDek(projectId).newVersion).toBe(2);
    expect(service.rotateDek(projectId).newVersion).toBe(3);
    expect(keyRows(projectId).map((r) => r.status)).toEqual([
      "retired",
      "retired",
      "active",
    ]);
  });

  test("throws ProjectKeyNotFoundError when no active key exists", () => {
    expect(() => service.rotateDek("prj_missing")).toThrow(
      ProjectKeyNotFoundError,
    );
  });
});

describe("getDekVersion", () => {
  test("caches per version (row deletion after first read is not seen)", () => {
    const projectId = newId("prj");
    insertProject(projectId);
    const created = service.createProjectDek(projectId);
    const first = service.getDekVersion(projectId, 1);
    db.run("DELETE FROM project_keys WHERE project_id = ?", [projectId]);
    const second = service.getDekVersion(projectId, 1);
    expect(second.dek.equals(created.dek)).toBe(true);
    expect(first.dek.equals(second.dek)).toBe(true);
  });

  test("throws ProjectKeyNotFoundError for an unknown version", () => {
    const projectId = newId("prj");
    insertProject(projectId);
    service.createProjectDek(projectId);
    expect(() => service.getDekVersion(projectId, 9)).toThrow(
      ProjectKeyNotFoundError,
    );
  });
});

describe("invalidate", () => {
  test("drops both the active and per-version caches", () => {
    const projectId = newId("prj");
    insertProject(projectId);
    service.createProjectDek(projectId);
    service.getDek(projectId);
    service.getDekVersion(projectId, 1);

    db.run("DELETE FROM project_keys WHERE project_id = ?", [projectId]);
    service.invalidate(projectId);

    expect(() => service.getDek(projectId)).toThrow(ProjectKeyNotFoundError);
    expect(() => service.getDekVersion(projectId, 1)).toThrow(
      ProjectKeyNotFoundError,
    );
  });

  test("only affects the given project", () => {
    const a = newId("prj");
    const b = newId("prj");
    insertProject(a);
    insertProject(b);
    service.createProjectDek(a);
    service.createProjectDek(b);
    db.run("DELETE FROM project_keys"); // both now only in cache
    service.invalidate(a);
    expect(() => service.getDek(a)).toThrow(ProjectKeyNotFoundError);
    expect(service.getDek(b).version).toBe(1);
  });
});
