import { defineConfig, devices } from "@playwright/test";

/**
 * Full-product e2e suite against a real `bun apps/api` instance serving the
 * built web UI (GARDENS_WEB_DIST) on a dedicated port.
 *
 * Bootstrap state (first-signup-becomes-owner) is global per server
 * instance, and the spec files build on each other's instance state in
 * order (01 creates the owner + storage state). Hence: ONE worker, no
 * parallelism, deterministic file order via the 01-…12- prefixes.
 */
export const E2E_PORT = 3179;
export const BASE_URL = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env.CI !== undefined,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Fresh SQLite + fresh master key on every run; redis on 6380 comes from
    // `docker compose -f compose.test.yml -p gardens-test up -d --wait`.
    command: "bun scripts/start-server.ts",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
