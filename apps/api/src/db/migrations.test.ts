import { describe, expect, test } from "bun:test";
import { openDb, runMigrations } from "./index";

const EXPECTED_TABLES = [
  "_migrations",
  "environments",
  "instance_settings",
  "project_keys",
  "project_memberships",
  "projects",
  "service_tokens",
  "user_tokens",
] as const;

function tableNames(db: ReturnType<typeof openDb>): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

describe("openDb", () => {
  test("enables foreign keys and busy timeout", () => {
    const db = openDb(":memory:");
    const fk = db
      .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
      .get();
    expect(fk?.foreign_keys).toBe(1);
    const busy = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
    expect(busy?.timeout).toBe(5000);
    db.close();
  });
});

describe("runMigrations", () => {
  test("creates all tables on a fresh database", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    expect(tableNames(db)).toEqual([...EXPECTED_TABLES]);
    db.close();
  });

  test("records applied migrations in the ledger", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const rows = db
      .query<{ name: string; applied_at: number }, []>(
        "SELECT name, applied_at FROM _migrations ORDER BY name",
      )
      .all();
    expect(rows.map((r) => r.name)).toEqual([
      "001_init",
      "002_membership_created_at",
      "003_user_token_created_via",
    ]);
    expect(rows[0]?.applied_at).toBeGreaterThan(0);
    db.close();
  });

  test("running twice is a no-op", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const before = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM _migrations")
      .get();
    expect(() => runMigrations(db)).not.toThrow();
    const after = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM _migrations")
      .get();
    expect(after?.n).toBe(before?.n ?? -1);
    expect(tableNames(db)).toEqual([...EXPECTED_TABLES]);
    db.close();
  });

  test("ON DELETE CASCADE works among our tables", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.run(
      "INSERT INTO projects (id, name, slug, created_by, created_at, updated_at) VALUES ('prj_a', 'A', 'a', 'usr_x', 1, 1)",
    );
    db.run(
      "INSERT INTO environments (id, project_id, name, slug, position, created_at) VALUES ('env_a', 'prj_a', 'Dev', 'dev', 0, 1)",
    );
    db.run("DELETE FROM projects WHERE id = 'prj_a'");
    const env = db
      .query<{ id: string }, []>("SELECT id FROM environments")
      .get();
    expect(env).toBeNull();
    db.close();
  });

  test("user_tokens.created_via defaults to 'session' and rejects unknown values", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.run(
      "INSERT INTO user_tokens (id, user_id, name, token_hash, token_prefix, created_at) VALUES ('ut_a', 'usr_x', 't', 'h1', 'p', 1)",
    );
    const row = db
      .query<{ created_via: string }, []>(
        "SELECT created_via FROM user_tokens WHERE id = 'ut_a'",
      )
      .get();
    expect(row?.created_via).toBe("session");
    expect(() =>
      db.run(
        "INSERT INTO user_tokens (id, user_id, name, token_hash, token_prefix, created_at, created_via) VALUES ('ut_b', 'usr_x', 't', 'h2', 'p', 1, 'magic')",
      ),
    ).toThrow();
    db.close();
  });

  test("created_by / user_id columns are NOT foreign keys to user", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    // No better-auth `user` table exists; inserting arbitrary user ids must work.
    expect(() =>
      db.run(
        "INSERT INTO projects (id, name, slug, created_by, created_at, updated_at) VALUES ('prj_b', 'B', 'b', 'usr_nonexistent', 1, 1)",
      ),
    ).not.toThrow();
    db.close();
  });
});
