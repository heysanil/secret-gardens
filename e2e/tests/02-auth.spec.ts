/**
 * Session auth flows. Runs without stored auth state — every test drives
 * the real login form. Sign-out here only revokes sessions created within
 * this file, never the owner state saved by 01-setup.
 */
import { expect, test } from "@playwright/test";
import { OWNER } from "../helpers/constants";
import { signIn, signOut } from "../helpers/ui";

test.describe
  .serial("authentication", () => {
    test("wrong password shows an inline error", async ({ page }) => {
      await page.goto("/login");
      await page.getByTestId("login-email").fill(OWNER.email);
      await page.getByTestId("login-password").fill("definitely-wrong-1!");
      await page.getByTestId("login-submit").click();
      await expect(page.getByText("Invalid email or password.")).toBeVisible();
      await expect(page).toHaveURL(/\/login/);
    });

    test("sign in works and the session persists across reload", async ({
      page,
    }) => {
      await signIn(page, OWNER.email, OWNER.password);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByTestId("projects-page-create")).toBeVisible();

      await page.reload();
      await expect(page.getByTestId("projects-page-create")).toBeVisible();
      await expect(page).not.toHaveURL(/\/login/);
    });

    test("sign out returns to /login and protects the app again", async ({
      page,
    }) => {
      await signIn(page, OWNER.email, OWNER.password);
      await signOut(page);
      await expect(page.getByTestId("login-email")).toBeVisible();

      await page.goto("/");
      await page.waitForURL(/\/login/);
    });

    test("/login?next=… is honored after sign-in", async ({ page }) => {
      await page.goto("/login?next=/account/tokens");
      await page.getByTestId("login-email").fill(OWNER.email);
      await page.getByTestId("login-password").fill(OWNER.password);
      await page.getByTestId("login-submit").click();
      await page.waitForURL((url) => url.pathname === "/account/tokens");
      await expect(page.getByTestId("pat-create")).toBeVisible();
    });

    test("unauthenticated deep link bounces to /login with next", async ({
      page,
    }) => {
      await page.goto("/account/tokens");
      await page.waitForURL(/\/login\?next=%2Faccount%2Ftokens/);
      await expect(page.getByTestId("login-email")).toBeVisible();
    });
  });
