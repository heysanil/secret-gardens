/**
 * Service tokens: creation through settings (read scope, dev only, 30 days),
 * the show-once contract, real Bearer usage against the API, and revocation.
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  createProject,
  envBySlug,
  newBearerContext,
  newOwnerContext,
  type ProjectDetail,
  putSecret,
} from "../helpers/api";
import { OWNER_STATE, unique } from "../helpers/constants";
import { expectToast } from "../helpers/ui";

test.use({ storageState: OWNER_STATE });

let api: APIRequestContext;
let project: ProjectDetail;
let devId: string;
let stagingId: string;
let token = "";

test.beforeAll(async () => {
  api = await newOwnerContext();
  project = await createProject(api, unique("Tokens UI"));
  devId = envBySlug(project, "dev").id;
  stagingId = envBySlug(project, "staging").id;
  await putSecret(api, project.id, devId, "CI_SECRET", "ci-secret-value");
});

test.afterAll(async () => {
  await api.dispose();
});

test.describe
  .serial("service tokens", () => {
    test("create a read token scoped to dev with 30-day expiry", async ({
      page,
    }) => {
      await page.goto(`/projects/${project.id}/settings`);
      await page.getByTestId("token-create").click();

      await page.getByTestId("token-name").fill("ci-pull");
      await page.getByTestId("token-scope-read").check();
      await page.getByTestId("token-env-dev").check();
      await page.getByTestId("token-expiry").fill("30");
      await page.getByTestId("token-create-submit").click();

      const shown = page.getByTestId("token-show-once");
      await expect(shown).toBeVisible();
      token = (await shown.locator("code").innerText()).trim();
      expect(token).toMatch(/^safe_st_/);

      await page.getByTestId("token-done").click();
      await expect(page.getByTestId("token-show-once")).toHaveCount(0);
    });

    test("the full token is never shown again", async ({ page }) => {
      await page.goto(`/projects/${project.id}/settings`);
      const row = page.locator('[data-testid^="token-row-"]', {
        hasText: "ci-pull",
      });
      await expect(row).toBeVisible();
      await expect(row).toContainText(`${token.slice(0, 12)}…`);
      await expect(row).toContainText("read");
      await expect(row).toContainText("envs: dev");

      // Reopening the create modal shows a blank form, not the minted token.
      await page.getByTestId("token-create").click();
      await expect(page.getByTestId("token-name")).toHaveValue("");
      await expect(page.getByTestId("token-show-once")).toHaveCount(0);
      await page.keyboard.press("Escape");

      await expect(page.getByText(token, { exact: true })).toHaveCount(0);
    });

    test("token reads dev secrets but cannot write or cross environments", async () => {
      const bearer = await newBearerContext(token);

      const read = await bearer.get(
        `/api/projects/${project.id}/environments/${devId}/secrets?include_values=true`,
      );
      expect(read.status()).toBe(200);
      const body = (await read.json()) as {
        secrets: { key: string; value?: string }[];
      };
      const secret = body.secrets.find((s) => s.key === "CI_SECRET");
      expect(secret?.value).toBe("ci-secret-value");

      // Read scope: writes are forbidden.
      const write = await bearer.put(
        `/api/projects/${project.id}/environments/${devId}/secrets/NEW_KEY`,
        { data: { value: "nope" } },
      );
      expect(write.status()).toBe(403);

      // Environment scoping: staging is out of bounds for this token.
      const staging = await bearer.get(
        `/api/projects/${project.id}/environments/${stagingId}/secrets`,
      );
      expect(staging.status()).toBe(403);

      await bearer.dispose();
    });

    test("revoking the token in the UI kills it immediately", async ({
      page,
    }) => {
      await page.goto(`/projects/${project.id}/settings`);
      const row = page.locator('[data-testid^="token-row-"]', {
        hasText: "ci-pull",
      });
      await row.getByTestId("token-revoke").click();
      await page.getByTestId("confirm-accept").click();
      await expectToast(page, "success", "Token revoked");
      await expect(row).toContainText("revoked");

      const bearer = await newBearerContext(token);
      const read = await bearer.get(
        `/api/projects/${project.id}/environments/${devId}/secrets`,
      );
      expect(read.status()).toBe(401);
      await bearer.dispose();
    });
  });
