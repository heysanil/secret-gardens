#!/usr/bin/env bun
/**
 * KEK rotation — thin CLI wrapper around src/services/kekRotation.ts.
 *
 * Re-wraps every project DEK (active and retired) and the kek_check from
 * GARDENS_MASTER_KEY to GARDENS_MASTER_KEY_NEW, in one SQLite transaction.
 * Secrets in Redis are untouched: envelope encryption means they are
 * encrypted with per-project DEKs — only the DEK wrapping changes.
 *
 * Run it inside the deployment context, with the app stopped or about to
 * be restarted:
 *
 *   docker compose run --rm \
 *     -e GARDENS_MASTER_KEY_NEW="$(openssl rand -base64 32)" \
 *     app bun apps/api/scripts/rotate-kek.ts
 *
 * or directly: GARDENS_MASTER_KEY=... GARDENS_MASTER_KEY_NEW=... \
 *   GARDENS_DB_PATH=./data/gardens.db bun apps/api/scripts/rotate-kek.ts
 */
import { existsSync } from "node:fs";
import {
  CryptoError,
  loadMasterKey,
  type MasterKey,
  MasterKeyError,
} from "@secret-gardens/crypto";
import { openDb } from "../src/db";
import { createAuditLog } from "../src/redis/audit";
import { createRedis } from "../src/redis/client";
import { KekRotationError, rotateKek } from "../src/services/kekRotation";

function fail(message: string): never {
  console.error(`rotate-kek: ${message}`);
  process.exit(1);
}

function loadKeyOrFail(name: string): MasterKey {
  try {
    return loadMasterKey(process.env[name]);
  } catch (err) {
    if (err instanceof MasterKeyError) {
      fail(`${name} is invalid: ${err.message}`);
    }
    throw err;
  }
}

const dbPath = process.env.GARDENS_DB_PATH ?? "./data/gardens.db";
if (!existsSync(dbPath)) {
  fail(
    `no database at ${dbPath} (GARDENS_DB_PATH) — point this script at the ` +
      "SQLite file the secret-gardens API uses.",
  );
}

const oldKey = loadKeyOrFail("GARDENS_MASTER_KEY");
const newKey = loadKeyOrFail("GARDENS_MASTER_KEY_NEW");

const db = openDb(dbPath);
let result: ReturnType<typeof rotateKek>;
try {
  result = rotateKek(db, oldKey, newKey);
} catch (err) {
  // rotateKek wraps crypto failures in KekRotationError; the CryptoError
  // arm is a safety net so no key/ciphertext problem ever escapes as a
  // raw stack trace.
  if (err instanceof KekRotationError || err instanceof CryptoError) {
    fail(err.message);
  }
  throw err;
} finally {
  db.close();
}

console.log(
  `rotate-kek: ${result.rewrapped} DEK(s) re-wrapped, ` +
    `${result.skipped} already wrapped with the new key (skipped), ` +
    `kek_check ${result.kekCheck} (old kek ${oldKey.kekId} → new kek ${newKey.kekId}).`,
);

// Best-effort kek.rotate entry on the instance audit stream. The rotation
// itself already succeeded — a missing REDIS_URL or a failed append must
// never turn that success into a non-zero exit, so warn and move on. The
// kekIds are public fingerprints (16 hex chars of SHA-256), fine to log.
const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined || redisUrl === "") {
  console.warn(
    "rotate-kek: REDIS_URL is not set — skipping the kek.rotate audit entry.",
  );
} else {
  // One-shot connection: no auto-reconnect (the server default would retry
  // an unreachable Redis forever and hang the script) and a short timeout.
  const redis = createRedis(redisUrl, {
    autoReconnect: false,
    connectionTimeout: 5_000,
  });
  try {
    await redis.connect();
    await createAuditLog(redis).appendAudit("instance", {
      action: "kek.rotate",
      actorType: "system",
      actorId: "rotate-kek",
      fields: {
        rewrapped: String(result.rewrapped),
        skipped: String(result.skipped),
        oldKekId: oldKey.kekId,
        newKekId: newKey.kekId,
      },
    });
  } catch (err) {
    console.warn(
      "rotate-kek: could not append the kek.rotate audit entry (the " +
        `rotation itself succeeded): ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    redis.close();
  }
}
console.log(`
Next steps:
  1. Set GARDENS_MASTER_KEY to the NEW key in your .env (replace the old value).
  2. Remove GARDENS_MASTER_KEY_NEW from the environment.
  3. Restart the app (docker compose up -d).
  4. BACK UP the new GARDENS_MASTER_KEY somewhere safe — losing it means losing
     all secrets permanently. The old key no longer decrypts anything.

Secrets stored in Redis were not touched: they are encrypted with
per-project DEKs (envelope encryption); only the DEK wrapping changed.`);
