/**
 * Playwright webServer entrypoint (run with bun, cwd = e2e/).
 *
 * 1. Ensures apps/web/dist exists (builds @secret-gardens/web if missing).
 * 2. Wipes the e2e SQLite database so every run starts on a fresh instance
 *    (this is what makes the 01-setup owner-signup flow repeatable).
 * 3. Boots the real API server in-process on E2E_PORT with
 *    GARDENS_WEB_DIST=apps/web/dist — the production/docker topology: the API
 *    serves the SPA itself, so the suite exercises static mode end to end
 *    (see tests/13-static-mode.spec.ts for the focused regression test).
 */
/// <reference types="bun-types" />

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMasterKey } from "@secret-gardens/crypto";

const E2E_PORT = 3179;

const e2eDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(e2eDir);
const webDist = join(repoRoot, "apps", "web", "dist");

if (!existsSync(join(webDist, "index.html"))) {
  console.log("apps/web/dist missing — building @secret-gardens/web…");
  const build = spawnSync(
    "bunx",
    ["turbo", "run", "build", "--filter=@secret-gardens/web"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (build.status !== 0) {
    console.error("failed to build @secret-gardens/web");
    process.exit(1);
  }
}

// Fail fast on stray servers: the API listens with SO_REUSEPORT, so a
// leftover process on E2E_PORT would silently share the port and the
// kernel would round-robin requests between fresh and stale instances.
try {
  await fetch(`http://localhost:${E2E_PORT}/`, {
    signal: AbortSignal.timeout(500),
  });
  console.error(
    `port ${E2E_PORT} is already in use — kill the stray server before running the e2e suite`,
  );
  process.exit(1);
} catch {
  // connection refused/timeout — the port is free.
}

const tmpDir = join(e2eDir, ".tmp");
mkdirSync(tmpDir, { recursive: true });
const dbPath = join(tmpDir, "gardens-e2e.db");
for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  rmSync(dbPath + suffix, { force: true });
}

process.env.PORT = String(E2E_PORT);
process.env.GARDENS_PUBLIC_URL = `http://localhost:${E2E_PORT}`;
process.env.GARDENS_DB_PATH = dbPath;
process.env.GARDENS_MASTER_KEY = generateMasterKey();
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.REDIS_URL = "redis://localhost:6380";
process.env.GARDENS_WEB_DIST = webDist;

// Importing the API entrypoint boots the server (config → migrations →
// redis → listen); this process IS the server, so Playwright's webServer
// shutdown terminates everything cleanly.
await import(join(repoRoot, "apps", "api", "src", "index.ts"));

console.log(
  `e2e server on http://localhost:${E2E_PORT} (GARDENS_WEB_DIST=${webDist})`,
);
