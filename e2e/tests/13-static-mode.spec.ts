/**
 * Regression test for a KNOWN BUG (currently test.fixme):
 *
 * When the API serves the built web UI itself (SAFE_WEB_DIST set — the
 * production/docker mode), @elysiajs/static registers a GET /* wildcard
 * that shadows the `.mount(auth.handler)` better-auth handler for GET
 * requests. Every GET better-auth endpoint then 404s with the API's JSON
 * not_found shape — most fatally GET /api/auth/get-session, so no browser
 * session can ever be established against a static-mode server.
 *
 * Repro outside this test:
 *   SAFE_WEB_DIST=apps/web/dist PORT=3999 … bun apps/api/src/index.ts
 *   curl -i http://localhost:3999/api/auth/get-session   # → 404, expected 200
 *   (POST /api/auth/* still works, which is why unit tests missed it.)
 *
 * Because of this, the e2e webServer (scripts/start-server.ts) fronts an
 * unmodified API with a static+proxy server (the vite-dev topology) instead
 * of using SAFE_WEB_DIST. Un-fixme this test once the bug is fixed, then
 * collapse start-server.ts back to a single SAFE_WEB_DIST server.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_DIR } from "../helpers/constants";

const STATIC_PORT = 3182;

test.describe("static-mode serving (SAFE_WEB_DIST)", () => {
  test.fixme(
    true,
    "GET /api/auth/* is shadowed by the static GET /* wildcard when SAFE_WEB_DIST is set",
  );

  test("GET /api/auth/get-session works with SAFE_WEB_DIST set", async ({
    request,
  }) => {
    const repoRoot = join(E2E_DIR, "..");
    const dbPath = join(E2E_DIR, ".tmp", "safe-static-mode.db");
    rmSync(dbPath, { force: true });

    let child: ChildProcess | null = null;
    try {
      child = spawn("bun", [join(repoRoot, "apps", "api", "src", "index.ts")], {
        env: {
          ...process.env,
          PORT: String(STATIC_PORT),
          SAFE_PUBLIC_URL: `http://localhost:${STATIC_PORT}`,
          SAFE_DB_PATH: dbPath,
          SAFE_MASTER_KEY: process.env.SAFE_MASTER_KEY,
          BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
          REDIS_URL: "redis://localhost:6380",
          SAFE_WEB_DIST: join(repoRoot, "apps", "web", "dist"),
        },
        stdio: "ignore",
      });

      await expect
        .poll(
          async () => {
            try {
              const res = await request.get(
                `http://localhost:${STATIC_PORT}/api/health`,
              );
              return res.status();
            } catch {
              return 0;
            }
          },
          { timeout: 30_000 },
        )
        .toBe(200);

      // The SPA must be served…
      const index = await request.get(`http://localhost:${STATIC_PORT}/`);
      expect(index.status()).toBe(200);
      expect(await index.text()).toContain('<div id="root">');

      // …AND GET better-auth endpoints must still be reachable. This is
      // what currently fails (404 {"error":"not_found"}).
      const session = await request.get(
        `http://localhost:${STATIC_PORT}/api/auth/get-session`,
      );
      expect(session.status()).toBe(200);
    } finally {
      child?.kill("SIGTERM");
      rmSync(dbPath, { force: true });
    }
  });
});
