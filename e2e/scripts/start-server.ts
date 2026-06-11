/**
 * Playwright webServer entrypoint (run with bun, cwd = e2e/).
 *
 * 1. Ensures apps/web/dist exists (builds @safe/web if missing).
 * 2. Wipes the e2e SQLite database so every run starts on a fresh instance
 *    (this is what makes the 01-setup owner-signup flow repeatable).
 * 3. Boots the real API server in-process on API_PORT, then serves the
 *    built web UI + an /api reverse proxy on E2E_PORT (same topology as
 *    `vite dev`, which proxies /api to the API).
 *
 * KNOWN BUG WORKAROUND: the suite was meant to run the API with
 * SAFE_WEB_DIST so the API serves the SPA itself, but in that mode the
 * static plugin's GET /* wildcard shadows the mounted better-auth handler:
 * GET /api/auth/get-session returns 404 and no browser session can exist.
 * See tests/13-static-mode.spec.ts (test.fixme) for the regression test.
 * Once fixed, this front proxy can be deleted and the API can listen on
 * E2E_PORT directly with SAFE_WEB_DIST=<webDist>.
 */
/// <reference types="bun-types" />

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMasterKey } from "@safe/crypto";

const E2E_PORT = 3179;
const API_PORT = 3180;

const e2eDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(e2eDir);
const webDist = join(repoRoot, "apps", "web", "dist");

if (!existsSync(join(webDist, "index.html"))) {
  console.log("apps/web/dist missing — building @safe/web…");
  const build = spawnSync(
    "bunx",
    ["turbo", "run", "build", "--filter=@safe/web"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (build.status !== 0) {
    console.error("failed to build @safe/web");
    process.exit(1);
  }
}

// Fail fast on stray servers: the API listens with SO_REUSEPORT, so a
// leftover process on API_PORT would silently share the port and the
// kernel would round-robin requests between fresh and stale instances.
for (const port of [E2E_PORT, API_PORT]) {
  try {
    await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(500),
    });
    console.error(
      `port ${port} is already in use — kill the stray server before running the e2e suite`,
    );
    process.exit(1);
  } catch {
    // connection refused/timeout — the port is free.
  }
}

const tmpDir = join(e2eDir, ".tmp");
mkdirSync(tmpDir, { recursive: true });
const dbPath = join(tmpDir, "safe-e2e.db");
for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  rmSync(dbPath + suffix, { force: true });
}

process.env.PORT = String(API_PORT);
// The public URL is the BROWSER-facing origin (the front proxy below):
// better-auth derives its trusted origin from it.
process.env.SAFE_PUBLIC_URL = `http://localhost:${E2E_PORT}`;
process.env.SAFE_DB_PATH = dbPath;
process.env.SAFE_MASTER_KEY = generateMasterKey();
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.REDIS_URL = "redis://localhost:6380";
delete process.env.SAFE_WEB_DIST; // see KNOWN BUG WORKAROUND above

// Importing the API entrypoint boots the server (config → migrations →
// redis → listen); this process IS the server, so Playwright's webServer
// shutdown terminates everything cleanly.
await import(join(repoRoot, "apps", "api", "src", "index.ts"));

// Front server: static files + SPA fallback, /api proxied to the API.
const indexHtml = await Bun.file(join(webDist, "index.html")).bytes();

Bun.serve({
  port: E2E_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return fetch(
        new Request(
          `http://127.0.0.1:${API_PORT}${url.pathname}${url.search}`,
          req,
        ),
        { redirect: "manual" },
      );
    }
    if (url.pathname !== "/") {
      const asset = Bun.file(join(webDist, url.pathname));
      if (await asset.exists()) {
        return new Response(asset);
      }
    }
    return new Response(indexHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

console.log(
  `e2e front server on http://localhost:${E2E_PORT} (api :${API_PORT})`,
);
