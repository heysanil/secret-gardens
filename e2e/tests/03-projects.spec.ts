/**
 * Project creation and navigation, driven entirely through the UI.
 */
import { expect, test } from "@playwright/test";
import { OWNER_STATE, slugOf, unique } from "../helpers/constants";
import { expectToast } from "../helpers/ui";

test.use({ storageState: OWNER_STATE });

const nameA = unique("Billing Alpha");
const slugA = slugOf(nameA);
const nameB = unique("Billing Beta");
const slugB = slugOf(nameB);

test.describe
  .serial("projects", () => {
    test("create a project via the modal with live slug preview", async ({
      page,
    }) => {
      await page.goto("/");
      await page.getByTestId("projects-page-create").click();
      await expect(page.getByTestId("project-create-modal")).toBeVisible();

      await page.getByTestId("project-create-name").fill(nameA);
      await expect(page.getByTestId("project-create-slug")).toHaveText(slugA);
      await page
        .getByTestId("project-create-description")
        .fill("Created by the e2e suite");
      await page.getByTestId("project-create-submit").click();

      await expectToast(page, "success", `Project "${nameA}" created`);
      await page.waitForURL(/\/projects\/prj_/);
      await expect(
        page.getByRole("heading", { level: 1, name: nameA }),
      ).toBeVisible();
    });

    test("project shows in the sidebar with default environment tabs", async ({
      page,
    }) => {
      await page.goto("/");
      await page.getByTestId(`sidebar-project-${slugA}`).click();
      await page.waitForURL(/\/projects\/prj_/);
      await expect(page.getByTestId("env-tab-dev")).toBeVisible();
      await expect(page.getByTestId("env-tab-staging")).toBeVisible();
      await expect(page.getByTestId("env-tab-prod")).toBeVisible();
      await expect(page.getByTestId(`project-card-${slugA}`)).toHaveCount(0);
    });

    test("create a second project and switch between them", async ({
      page,
    }) => {
      await page.goto("/");
      // The sidebar "+ New project" affordance opens the same modal.
      await page.getByTestId("project-create").click();
      await page.getByTestId("project-create-name").fill(nameB);
      await page.getByTestId("project-create-submit").click();
      await page.waitForURL(/\/projects\/prj_/);
      await expect(
        page.getByRole("heading", { level: 1, name: nameB }),
      ).toBeVisible();

      await page.getByTestId(`sidebar-project-${slugA}`).click();
      await expect(
        page.getByRole("heading", { level: 1, name: nameA }),
      ).toBeVisible();

      await page.getByTestId(`sidebar-project-${slugB}`).click();
      await expect(
        page.getByRole("heading", { level: 1, name: nameB }),
      ).toBeVisible();

      // The projects index lists both as cards.
      await page.goto("/");
      await expect(page.getByTestId(`project-card-${slugA}`)).toBeVisible();
      await expect(page.getByTestId(`project-card-${slugB}`)).toBeVisible();
    });
  });
