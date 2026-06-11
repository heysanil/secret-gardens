/**
 * Personal access tokens: show-once creation, Bearer usage, the createdVia
 * badge for tokens minted with another token, and revocation.
 */
import { expect, test } from "@playwright/test";
import { newBearerContext } from "../helpers/api";
import { OWNER, OWNER_STATE } from "../helpers/constants";
import { expectToast } from "../helpers/ui";

test.use({ storageState: OWNER_STATE });

let patToken = "";

test.describe
  .serial("personal access tokens", () => {
    test("create a PAT with a show-once screen", async ({ page }) => {
      await page.goto("/account/tokens");
      await page.getByTestId("pat-create").click();
      await page.getByTestId("pat-name").fill("e2e-parent-pat");
      await page.getByTestId("pat-create-submit").click();

      const shown = page.getByTestId("token-show-once");
      await expect(shown).toBeVisible();
      patToken = (await shown.locator("code").innerText()).trim();
      expect(patToken).toMatch(/^sg_ut_/);

      await page.getByRole("button", { name: "Done" }).click();
      await expect(page.getByTestId("token-show-once")).toHaveCount(0);
      await expect(
        page.locator('[data-testid^="pat-row-"]', {
          hasText: "e2e-parent-pat",
        }),
      ).toBeVisible();
      await expect(page.getByText(patToken, { exact: true })).toHaveCount(0);
    });

    test("the PAT authenticates Bearer API calls as the owner", async () => {
      const bearer = await newBearerContext(patToken);
      const res = await bearer.get("/api/me");
      expect(res.status()).toBe(200);
      const me = (await res.json()) as { email: string; instanceRole: string };
      expect(me.email).toBe(OWNER.email);
      expect(me.instanceRole).toBe("owner");
      await bearer.dispose();
    });

    test("a PAT minted via Bearer gets the createdVia badge", async ({
      page,
    }) => {
      // Mint a child token using the parent PAT (the CLI does exactly this).
      const bearer = await newBearerContext(patToken);
      const res = await bearer.post("/api/me/tokens", {
        data: { name: "e2e-child-pat" },
      });
      expect(res.status()).toBe(201);
      const child = (await res.json()) as { id: string; expiresAt: number };
      // Token-minted tokens are capped server-side at 30 days.
      expect(child.expiresAt).not.toBeNull();
      await bearer.dispose();

      await page.goto("/account/tokens");
      const childRow = page.getByTestId(`pat-row-${child.id}`);
      await expect(childRow).toBeVisible();
      await expect(childRow).toContainText("via CLI token");

      // The session-minted parent has no such badge.
      await expect(
        page.locator('[data-testid^="pat-row-"]', {
          hasText: "e2e-parent-pat",
        }),
      ).not.toContainText("via CLI token");
    });

    test("revoking the PAT in the UI invalidates it immediately", async ({
      page,
    }) => {
      await page.goto("/account/tokens");
      const row = page.locator('[data-testid^="pat-row-"]', {
        hasText: "e2e-parent-pat",
      });
      await row.getByTestId("pat-revoke").click();
      await page.getByTestId("confirm-accept").click();
      await expectToast(page, "success", "Token revoked");
      await expect(row).toContainText("revoked");

      const bearer = await newBearerContext(patToken);
      const res = await bearer.get("/api/me");
      expect(res.status()).toBe(401);
      await bearer.dispose();
    });
  });
