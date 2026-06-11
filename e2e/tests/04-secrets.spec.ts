/**
 * Secrets table CRUD in a dedicated project: key validation, masking,
 * reveal, inline edit, multiline values, client-side filtering, delete.
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  createProject,
  newOwnerContext,
  type ProjectDetail,
} from "../helpers/api";
import { OWNER_STATE, unique } from "../helpers/constants";
import { expectToast } from "../helpers/ui";

test.use({ storageState: OWNER_STATE });

let api: APIRequestContext;
let project: ProjectDetail;

test.beforeAll(async () => {
  api = await newOwnerContext();
  project = await createProject(api, unique("Secrets UI"));
});

test.afterAll(async () => {
  await api.dispose();
});

test.describe
  .serial("secrets table", () => {
    test("key validation rejects bad keys before submit", async ({ page }) => {
      await page.goto(`/projects/${project.id}`);
      await page.getByTestId("add-secret-key").fill("1BAD-KEY");
      await expect(
        page.getByText(
          "Secret key must start with a letter or underscore and contain only letters, digits, and underscores",
        ),
      ).toBeVisible();
      await expect(page.getByTestId("add-secret-submit")).toBeDisabled();
    });

    test("add a secret; value is masked by default", async ({ page }) => {
      await page.goto(`/projects/${project.id}`);
      await page.getByTestId("add-secret-key").fill("DATABASE_URL");
      await page
        .getByTestId("add-secret-value")
        .fill("postgres://app:hunter2@db.internal:5432/app");
      await page.getByTestId("add-secret-submit").click();

      await expectToast(page, "success", "DATABASE_URL created");
      const row = page.getByTestId("secret-row-DATABASE_URL");
      await expect(row).toBeVisible();
      await expect(row).toContainText("v1");
      await expect(row).toContainText("••••••••");
      await expect(row.getByTestId("secret-value")).toHaveCount(0);
    });

    test("reveal shows the decrypted value", async ({ page }) => {
      await page.goto(`/projects/${project.id}`);
      const row = page.getByTestId("secret-row-DATABASE_URL");
      await row.getByTestId("reveal-toggle").click();
      await expect(row.getByTestId("secret-value")).toHaveText(
        "postgres://app:hunter2@db.internal:5432/app",
      );

      // Toggling again re-masks it.
      await row.getByTestId("reveal-toggle").click();
      await expect(row.getByTestId("secret-value")).toHaveCount(0);
      await expect(row).toContainText("••••••••");
    });

    test("inline edit writes a new version", async ({ page }) => {
      await page.goto(`/projects/${project.id}`);
      const row = page.getByTestId("secret-row-DATABASE_URL");
      await row.getByTestId("reveal-toggle").click();
      await row.getByTestId("secret-value").click();
      await row
        .getByTestId("secret-edit-input")
        .fill("postgres://app:rotated@db.internal:5432/app");
      await row.getByTestId("secret-edit-save").click();

      await expectToast(page, "success", "DATABASE_URL updated to v2");
      await expect(row).toContainText("v2");
      await expect(row.getByTestId("secret-value")).toHaveText(
        "postgres://app:rotated@db.internal:5432/app",
      );
    });

    test("multiline secret via the textarea", async ({ page }) => {
      await page.goto(`/projects/${project.id}`);
      await page.getByTestId("add-secret-key").fill("TLS_CERT");
      await page
        .getByTestId("add-secret-value")
        .fill("-----BEGIN CERT-----\nline-two\n-----END CERT-----");
      await page.getByTestId("add-secret-submit").click();
      await expectToast(page, "success", "TLS_CERT created");

      const row = page.getByTestId("secret-row-TLS_CERT");
      await row.getByTestId("reveal-toggle").click();
      await expect(row.getByTestId("secret-value")).toContainText(
        "-----BEGIN CERT-----",
      );
      await expect(row.getByTestId("secret-value")).toContainText("line-two");
      await expect(row.getByTestId("secret-value")).toContainText(
        "-----END CERT-----",
      );
    });

    test("client-side filter narrows rows", async ({ page }) => {
      await page.goto(`/projects/${project.id}`);
      await expect(page.getByTestId("secret-row-DATABASE_URL")).toBeVisible();
      await expect(page.getByTestId("secret-row-TLS_CERT")).toBeVisible();

      await page.getByTestId("secret-filter").fill("database");
      await expect(page.getByTestId("secret-row-DATABASE_URL")).toBeVisible();
      await expect(page.getByTestId("secret-row-TLS_CERT")).toHaveCount(0);
      await expect(page.getByText("1 of 2 secrets")).toBeVisible();

      await page.getByTestId("secret-filter").fill("nomatch");
      await expect(page.getByText('No keys match "nomatch"')).toBeVisible();

      await page.getByTestId("secret-filter").clear();
      await expect(page.getByTestId("secret-row-TLS_CERT")).toBeVisible();
    });

    test("delete a secret with confirmation", async ({ page }) => {
      await page.goto(`/projects/${project.id}`);
      const row = page.getByTestId("secret-row-TLS_CERT");
      await row.getByTestId("secret-delete").click();

      await expect(page.getByTestId("confirm-dialog")).toBeVisible();
      // Cancel first — nothing happens.
      await page.getByTestId("confirm-cancel").click();
      await expect(row).toBeVisible();

      await row.getByTestId("secret-delete").click();
      await page.getByTestId("confirm-accept").click();
      await expectToast(page, "success", "TLS_CERT deleted");
      await expect(page.getByTestId("secret-row-TLS_CERT")).toHaveCount(0);
      await expect(page.getByTestId("secret-row-DATABASE_URL")).toBeVisible();
    });
  });
