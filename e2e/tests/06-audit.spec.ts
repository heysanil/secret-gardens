/**
 * Audit log page: pagination past the 50-entry first page, action filter,
 * environment filter. Seeded via one bulk push of 60 keys (60 secret.create
 * entries) plus one staging write, on top of the project.create entry.
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  bulkPutSecrets,
  createProject,
  envBySlug,
  newOwnerContext,
  type ProjectDetail,
  putSecret,
} from "../helpers/api";
import { OWNER_STATE, unique } from "../helpers/constants";

test.use({ storageState: OWNER_STATE });

const BULK_KEYS = 60;

let api: APIRequestContext;
let project: ProjectDetail;

test.beforeAll(async () => {
  api = await newOwnerContext();
  project = await createProject(api, unique("Audit UI"));
  const devId = envBySlug(project, "dev").id;
  const stagingId = envBySlug(project, "staging").id;

  const secrets: Record<string, string> = {};
  for (let i = 0; i < BULK_KEYS; i++) {
    secrets[`BULK_KEY_${String(i).padStart(3, "0")}`] = `value-${i}`;
  }
  await bulkPutSecrets(api, project.id, devId, secrets);
  await putSecret(api, project.id, stagingId, "STAGING_ONLY", "staging-value");
});

test.afterAll(async () => {
  await api.dispose();
});

// project.create + 60 bulk creates + 1 staging create.
const TOTAL_ENTRIES = 1 + BULK_KEYS + 1;

test.describe
  .serial("audit log", () => {
    test("first page lists 50 entries; Load more fetches the rest", async ({
      page,
    }) => {
      await page.goto(`/projects/${project.id}/audit`);
      await expect(page.getByTestId("audit-row")).toHaveCount(50);

      await page.getByTestId("audit-load-more").click();
      await expect(page.getByTestId("audit-row")).toHaveCount(TOTAL_ENTRIES);
      await expect(page.getByTestId("audit-load-more")).toHaveCount(0);
    });

    test("action filter narrows to secret.create", async ({ page }) => {
      await page.goto(`/projects/${project.id}/audit`);
      await page
        .getByTestId("audit-action-filter")
        .selectOption("secret.create");

      // 61 secret.create entries → first page is exactly 50, all creates.
      await expect(page.getByTestId("audit-row")).toHaveCount(50);
      const badges = await page
        .getByTestId("audit-row")
        .locator("td:nth-child(2)")
        .allInnerTexts();
      expect(badges.every((b) => b.trim() === "secret.create")).toBe(true);

      await page.getByTestId("audit-load-more").click();
      await expect(page.getByTestId("audit-row")).toHaveCount(BULK_KEYS + 1);
    });

    test("environment filter narrows to staging", async ({ page }) => {
      await page.goto(`/projects/${project.id}/audit`);
      await page
        .getByTestId("audit-env-filter")
        .selectOption({ label: "Staging" });

      await expect(page.getByTestId("audit-row")).toHaveCount(1);
      await expect(page.getByTestId("audit-row")).toContainText("STAGING_ONLY");
      await expect(page.getByTestId("audit-row")).toContainText("staging");
    });
  });
