import type { Database } from "bun:sqlite";

/** instance_settings key: 'true'/'false'. Flipped to 'false' after first signup. */
export const ALLOW_SIGNUP_KEY = "allow_signup";

/**
 * Counts rows in better-auth's `user` table. Only callable after the
 * better-auth migrations have run (boot runs them before listening).
 */
export function countUsers(db: Database): number {
  const row = db
    .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM "user"')
    .get();
  return row?.n ?? 0;
}

export function getInstanceSetting(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>(
      "SELECT value FROM instance_settings WHERE key = ?",
    )
    .get(key);
  return row?.value ?? null;
}

export function setInstanceSetting(
  db: Database,
  key: string,
  value: string,
): void {
  db.run(
    "INSERT INTO instance_settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}
