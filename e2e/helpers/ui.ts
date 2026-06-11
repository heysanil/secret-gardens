import { expect, type Page } from "@playwright/test";

/** Signs in through the real login form and waits to leave /login. */
export async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.waitForURL((url) => url.pathname !== "/login");
}

/** Signs out via the user menu and waits for the login screen. */
export async function signOut(page: Page): Promise<void> {
  await page.getByTestId("user-menu").click();
  await page.getByTestId("user-menu-signout").click();
  await page.waitForURL(/\/login/);
}

/** Asserts a toast of the given tone containing `text` is showing. */
export async function expectToast(
  page: Page,
  tone: "success" | "error",
  text: string | RegExp,
): Promise<void> {
  await expect(
    page.getByTestId(`toast-${tone}`).filter({ hasText: text }).first(),
  ).toBeVisible();
}
