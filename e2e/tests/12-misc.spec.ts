/**
 * Odds and ends: the 404 page (root error boundary is not cheaply
 * triggerable without breaking the app shell, so it is intentionally not
 * covered here).
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
});
