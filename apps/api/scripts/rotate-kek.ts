#!/usr/bin/env bun
/**
 * KEK rotation — thin CLI wrapper around src/services/kekRotation.ts.
 *
 * Re-wraps every project DEK (active and retired) and the kek_check from
 * SAFE_MASTER_KEY to SAFE_MASTER_KEY_NEW, in one SQLite transaction.
 * Secrets in Redis are untouched: envelope encryption means they are
 * encrypted with per-project DEKs — only the DEK wrapping changes.
 *
 * Run it inside the deployment context, with the app stopped or about to
 * be restarted:
 *
 *   docker compose run --rm \
 *     -e SAFE_MASTER_KEY_NEW="$(openssl rand -base64 32)" \
 *     app bun apps/api/scripts/rotate-kek.ts
 *
 * or directly: SAFE_MASTER_KEY=... SAFE_MASTER_KEY_NEW=... \
 *   SAFE_DB_PATH=./data/safe.db bun apps/api/scripts/rotate-kek.ts
 */
import { existsSync } from "node:fs";
import {
  CryptoError,
  loadMasterKey,
  type MasterKey,
  MasterKeyError,
} from "@safe/crypto";
import { openDb } from "../src/db";
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

const dbPath = process.env.SAFE_DB_PATH ?? "./data/safe.db";
if (!existsSync(dbPath)) {
  fail(
    `no database at ${dbPath} (SAFE_DB_PATH) — point this script at the ` +
      "SQLite file the safe API uses.",
  );
}

const oldKey = loadKeyOrFail("SAFE_MASTER_KEY");
const newKey = loadKeyOrFail("SAFE_MASTER_KEY_NEW");

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
console.log(`
Next steps:
  1. Set SAFE_MASTER_KEY to the NEW key in your .env (replace the old value).
  2. Remove SAFE_MASTER_KEY_NEW from the environment.
  3. Restart the app (docker compose up -d).
  4. BACK UP the new SAFE_MASTER_KEY somewhere safe — losing it means losing
     all secrets permanently. The old key no longer decrypts anything.

Secrets stored in Redis were not touched: they are encrypted with
per-project DEKs (envelope encryption); only the DEK wrapping changed.`);
