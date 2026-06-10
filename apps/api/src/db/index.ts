import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations";

export { newId } from "./ids";
export { MIGRATIONS } from "./migrations";

/**
 * Opens (creating if needed) the SQLite database with the standard pragmas:
 * WAL journaling, foreign keys enforced, 5s busy timeout.
 */
export function openDb(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/**
 * Applies pending migrations in name order, each inside its own transaction,
 * recording them in the `_migrations` ledger. Idempotent.
 */
export function runMigrations(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const isApplied = db.query<{ name: string }, [string]>(
    "SELECT name FROM _migrations WHERE name = ?",
  );
  const record = db.query<unknown, [string, number]>(
    "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (isApplied.get(migration.name)) {
      continue;
    }
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.name, Date.now());
    });
    apply();
  }
}
