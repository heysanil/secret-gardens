/**
 * First-run setup flow. MUST run first: it performs the one-and-only owner
 * signup on the fresh instance and saves the owner session storage state
 * that later spec files reuse.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test } from "@playwright/test";
import { OWNER, OWNER_STATE } from "../helpers/constants";
import { signIn, signOut } from "../helpers/ui";

test.describe
  .serial("first-run setup", () => {
    test("fresh instance redirects everything to /setup", async ({ page }) => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/setup$/);
      await expect(page.getByTestId("setup-email")).toBeVisible();

      // Deep links are also forced to /setup while no user exists.
      await page.goto("/account/tokens");
      await expect(page).toHaveURL(/\/setup$/);
    });

    test("owner signup lands in the app and becomes the instance owner", async ({
      page,
    }) => {
      await page.goto("/setup");
      await page.getByTestId("setup-name").fill(OWNER.name);
      await page.getByTestId("setup-email").fill(OWNER.email);
      await page.getByTestId("setup-password").fill(OWNER.password);
      await page.getByTestId("setup-submit").click();

      await page.waitForURL((url) => url.pathname === "/");
      await expect(page.getByTestId("projects-page-create")).toBeVisible();
      // The sidebar user block shows the owner role badge.
      await expect(page.getByTestId("user-menu")).toContainText(OWNER.email);
      await expect(page.getByTestId("user-menu")).toContainText("owner");

      mkdirSync(dirname(OWNER_STATE), { recursive: true });
      await page.context().storageState({ path: OWNER_STATE });
    });

    test("revisiting /setup with a session redirects into the app", async ({
      browser,
    }) => {
      const context = await browser.newContext({ storageState: OWNER_STATE });
      const page = await context.newPage();
      await page.goto("/setup");
      // needsSetup=false bounces /setup → /login, which a live session
      // immediately resolves to the app root.
      await page.waitForURL((url) => url.pathname === "/");
      await expect(page.getByTestId("projects-page-create")).toBeVisible();
      await context.close();
    });

    test("second signup is blocked once the owner exists", async ({ page }) => {
      // Exercise the UI path: sign in, sign out, then try /setup again.
      await signIn(page, OWNER.email, OWNER.password);
      await signOut(page);
      await page.goto("/setup");
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByTestId("setup-email")).toHaveCount(0);

      // And the API path: self-signup is disabled after the first user.
      const res = await page.request.post("/api/auth/sign-up/email", {
        data: {
          name: "Intruder",
          email: "intruder@e2e.test",
          password: "intruder-password-123!",
        },
      });
      expect(res.ok()).toBe(false);
    });
  });
