/**
 * Version history drawer: op badges, admin value reveal, rollback, and
 * tombstone behavior for a deleted-then-recreated key (the version counter
 * is append-only per key, so history survives deletion).
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  createProject,
  deleteSecret,
  envBySlug,
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

test.beforeAll(async () => {
  api = await newOwnerContext();
  project = await createProject(api, unique("Versions UI"));
  devId = envBySlug(project, "dev").id;
  // ROT_KEY: three writes → v1 create, v2 update, v3 update.
  await putSecret(api, project.id, devId, "ROT_KEY", "alpha-1");
  await putSecret(api, project.id, devId, "ROT_KEY", "alpha-2");
  await putSecret(api, project.id, devId, "ROT_KEY", "alpha-3");
  // TOMB_KEY: create → delete → recreate (v1, v2 tombstone, v3).
  await putSecret(api, project.id, devId, "TOMB_KEY", "first-life");
  await deleteSecret(api, project.id, devId, "TOMB_KEY");
  await putSecret(api, project.id, devId, "TOMB_KEY", "second-life");
});

test.afterAll(async () => {
  await api.dispose();
});

test.describe
  .serial("version history", () => {
    test("drawer lists v1..v3 with op badges", async ({ page }) => {
      await page.goto(`/projects/${project.id}`);
      await page
        .getByTestId("secret-row-ROT_KEY")
        .getByTestId("secret-history")
        .click();

      const drawer = page.getByTestId("versions-drawer");
      await expect(drawer).toBeVisible();
      await expect(drawer.getByTestId("version-row-3")).toContainText("update");
      await expect(drawer.getByTestId("version-row-2")).toContainText("update");
      await expect(drawer.getByTestId("version-row-1")).toContainText("create");
    });

    test("admin can reveal historical values in the drawer", async ({
      page,
    }) => {
      await page.goto(`/projects/${project.id}`);
      await page
        .getByTestId("secret-row-ROT_KEY")
        .getByTestId("secret-history")
        .click();
      const drawer = page.getByTestId("versions-drawer");

      await drawer.getByTestId("versions-reveal-toggle").click();
      await expect(drawer.getByTestId("version-row-1")).toContainText(
        "alpha-1",
      );
      await expect(drawer.getByTestId("version-row-2")).toContainText(
        "alpha-2",
      );
      await expect(drawer.getByTestId("version-row-3")).toContainText(
        "alpha-3",
      );

      await drawer.getByTestId("versions-reveal-toggle").click();
      await expect(drawer.getByTestId("version-row-1")).not.toContainText(
        "alpha-1",
      );
    });

    test("rollback to v1 appends v4 with a rollback badge", async ({
      page,
    }) => {
      await page.goto(`/projects/${project.id}`);
      await page
        .getByTestId("secret-row-ROT_KEY")
        .getByTestId("secret-history")
        .click();
      const drawer = page.getByTestId("versions-drawer");

      await drawer
        .getByTestId("version-row-1")
        .getByTestId("version-rollback")
        .click();
      await page.getByTestId("confirm-accept").click();
      await expectToast(page, "success", "Rolled back to v1 as v4");

      const v4 = drawer.getByTestId("version-row-4");
      await expect(v4).toContainText("rollback");
      await expect(v4).toContainText("of v1");

      // The table now shows v4 carrying v1's value.
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      const row = page.getByTestId("secret-row-ROT_KEY");
      await expect(row).toContainText("v4");
      await row.getByTestId("reveal-toggle").click();
      await expect(row.getByTestId("secret-value")).toHaveText("alpha-1");
    });

    test("deleted-then-recreated key keeps one continuous history", async ({
      page,
    }) => {
      await page.goto(`/projects/${project.id}`);
      const row = page.getByTestId("secret-row-TOMB_KEY");
      // The re-created secret is at v3 (v2 was the tombstone).
      await expect(row).toContainText("v3");
      await row.getByTestId("secret-history").click();

      const drawer = page.getByTestId("versions-drawer");
      await expect(drawer.getByTestId("version-row-3")).toContainText("create");
      await expect(drawer.getByTestId("version-row-2")).toContainText("delete");
      await expect(drawer.getByTestId("version-row-1")).toContainText("create");

      // The tombstone can never be a rollback target.
      await expect(
        drawer.getByTestId("version-row-2").getByTestId("version-rollback"),
      ).toBeDisabled();

      // With values revealed, the tombstone shows "no value".
      await drawer.getByTestId("versions-reveal-toggle").click();
      await expect(drawer.getByTestId("version-row-1")).toContainText(
        "first-life",
      );
      await expect(drawer.getByTestId("version-row-2")).toContainText(
        "no value (deleted)",
      );
      await expect(drawer.getByTestId("version-row-3")).toContainText(
        "second-life",
      );
    });
  });
