/**
 * Regression test: with the API serving the built web UI itself
 * (GARDENS_WEB_DIST set — the production/docker mode), GET better-auth
 * endpoints must remain reachable.
 *
 * History: @elysiajs/static used to register a GET /* wildcard that
 * shadowed the `.mount(auth.handler)` better-auth handler for GET requests
 * — every GET better-auth endpoint 404ed with the API's JSON not_found
 * shape, most fatally GET /api/auth/get-session, so no browser session
 * could ever be established against a static-mode server. (POST
 * /api/auth/* still worked, which is why unit tests missed it.) The fix
 * serves dist files as explicit per-file routes and forwards unmatched
 * /api GETs from the SPA-fallback wildcard to the auth handler.
 *
 * The whole suite now runs in static mode (scripts/start-server.ts boots
 * the API with GARDENS_WEB_DIST), but this test pins the exact failure mode
 * against a dedicated instance.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_DIR } from "../helpers/constants";

const STATIC_PORT = 3182;

test.describe("static-mode serving (GARDENS_WEB_DIST)", () => {
  test("GET /api/auth/get-session works with GARDENS_WEB_DIST set", async ({
    request,
  }) => {
    const repoRoot = join(E2E_DIR, "..");
    const dbPath = join(E2E_DIR, ".tmp", "gardens-static-mode.db");
    rmSync(dbPath, { force: true });

    let child: ChildProcess | null = null;
    try {
      child = spawn("bun", [join(repoRoot, "apps", "api", "src", "index.ts")], {
        env: {
          ...process.env,
          PORT: String(STATIC_PORT),
          GARDENS_PUBLIC_URL: `http://localhost:${STATIC_PORT}`,
          GARDENS_DB_PATH: dbPath,
          GARDENS_MASTER_KEY: randomBytes(32).toString("base64"),
          BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
          REDIS_URL: "redis://localhost:6380",
          GARDENS_WEB_DIST: join(repoRoot, "apps", "web", "dist"),
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

      // …AND GET better-auth endpoints must still be reachable (this is
      // what regressed: 404 {"error":"not_found"}).
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
