/**
 * Odds and ends: the 404 page (root error boundary is not cheaply
 * triggerable without breaking the app shell, so it is intentionally not
 * covered here), and the public OpenAPI docs at /docs (the suite's server
 * runs the static topology, so this also pins /docs winning over the SPA
 * GET /* fallback).
 */
import { expect, test } from "@playwright/test";
import { OWNER_STATE } from "../helpers/constants";

test.describe("misc", () => {
  test("404 page renders for unknown routes (signed in)", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: OWNER_STATE });
    const page = await context.newPage();
    await page.goto("/nonexistent");
    await expect(page.getByText("404")).toBeVisible();
    await expect(page.getByText("This page doesn't exist.")).toBeVisible();
    await page.getByRole("link", { name: "Back to projects →" }).click();
    await page.waitForURL((url) => url.pathname === "/");
    await context.close();
  });

  test("404 page renders for unknown routes (signed out)", async ({ page }) => {
    // The catch-all route sits outside RequireSession, so even anonymous
    // visitors get the 404 page rather than a login bounce.
    await page.goto("/totally/made/up");
    await expect(page.getByText("404")).toBeVisible();
    await expect(page.getByText("This page doesn't exist.")).toBeVisible();
  });

  test("/docs renders the Scalar API reference (no auth)", async ({ page }) => {
    // Anonymous on purpose: the docs are public. Assert on the served page
    // itself (title + Scalar mount point), not on the CDN-loaded Scalar
    // bundle, so the test does not depend on external network.
    await page.goto("/docs");
    await expect(page).toHaveTitle("secret-gardens API");
    await expect(page.locator("#api-reference")).toBeAttached();
  });

  test("/docs/json serves the OpenAPI spec covering the route groups", async ({
    request,
  }) => {
    const res = await request.get("/docs/json");
    expect(res.status()).toBe(200);
    const spec = (await res.json()) as {
      openapi?: string;
      info?: { title?: string };
      paths?: Record<string, unknown>;
    };
    expect(spec.openapi).toBeTruthy();
    expect(spec.info?.title).toBe("secret-gardens API");
    const paths = Object.keys(spec.paths ?? {});
    for (const expected of [
      "/api/health",
      "/api/bootstrap",
      "/api/me/tokens",
      "/api/users",
      "/api/projects/{projectId}",
      "/api/projects/{projectId}/members/{userId}",
      "/api/projects/{projectId}/tokens/{tokenId}",
      "/api/projects/{projectId}/audit/",
      "/api/projects/{projectId}/environments/{envId}/secrets/{key}/rollback",
    ]) {
      expect(paths).toContain(expected);
    }
    // Static-mode noise (per-file routes, the SPA fallback) must not leak.
    for (const path of paths) {
      expect(path).toMatch(/^\/api\//);
    }
  });
});
