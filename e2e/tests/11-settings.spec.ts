/**
 * Project settings: rename, environment lifecycle (add/rename/typed-confirm
 * delete), DEK rotation, and typed-confirm project deletion.
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  createProject,
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

test.beforeAll(async () => {
  api = await newOwnerContext();
  project = await createProject(api, unique("Settings UI"));
  await putSecret(
    api,
    project.id,
    envBySlug(project, "dev").id,
    "KEEP_ME",
    "survives-rotation",
  );
});

test.afterAll(async () => {
  await api.dispose();
});

test.describe
  .serial("project settings", () => {
    test("rename the project; the sidebar updates", async ({ page }) => {
      await page.goto(`/projects/${project.id}/settings`);
      const newName = `${project.name} Renamed`;
      await page.getByTestId("general-name").fill(newName);
      await page.getByTestId("general-save").click();
      await expectToast(page, "success", "Project updated");

      // Slug is immutable, so the sidebar entry keeps its testid.
      await expect(
        page.getByTestId(`sidebar-project-${project.slug}`),
      ).toHaveText(newName);
      await expect(
        page.getByRole("heading", { level: 1, name: newName }),
      ).toBeVisible();
    });

    test("add an environment; its tab appears on the secrets page", async ({
      page,
    }) => {
      await page.goto(`/projects/${project.id}/settings`);
      await page.getByTestId("env-add-name").fill("QA");
      await page.getByTestId("env-add-slug").fill("qa");
      await page.getByTestId("env-add-submit").click();
      await expectToast(page, "success", 'Environment "QA" added');
      await expect(page.getByTestId("env-row-qa")).toBeVisible();

      await page.goto(`/projects/${project.id}`);
      await expect(page.getByTestId("env-tab-qa")).toBeVisible();
    });

    test("duplicate environment slug is rejected inline", async ({ page }) => {
      await page.goto(`/projects/${project.id}/settings`);
      await page.getByTestId("env-add-name").fill("QA Again");
      await page.getByTestId("env-add-slug").fill("qa");
      await expect(
        page.getByText("Slug already used in this project."),
      ).toBeVisible();
      await expect(page.getByTestId("env-add-submit")).toBeDisabled();
    });

    test("rename an environment", async ({ page }) => {
      await page.goto(`/projects/${project.id}/settings`);
      await page.getByTestId("env-row-qa").getByTestId("env-rename").click();
      await page.getByTestId("env-rename-input").fill("Quality Assurance");
      await page
        .getByTestId("env-row-qa")
        .getByRole("button", { name: "Save" })
        .click();
      await expectToast(page, "success", "Environment renamed");
      await expect(page.getByTestId("env-row-qa")).toContainText(
        "Quality Assurance",
      );
    });

    test("delete an environment with typed confirmation", async ({ page }) => {
      await page.goto(`/projects/${project.id}/settings`);
      await page.getByTestId("env-row-qa").getByTestId("env-delete").click();

      // The confirm button stays disabled until the exact phrase is typed.
      await expect(page.getByTestId("confirm-accept")).toBeDisabled();
      await page.getByTestId("confirm-input").fill("delete qa");
      await page.getByTestId("confirm-accept").click();
      await expectToast(page, "success", "Environment deleted");
      await expect(page.getByTestId("env-row-qa")).toHaveCount(0);

      await page.goto(`/projects/${project.id}`);
      await expect(page.getByTestId("env-tab-dev")).toBeVisible();
      await expect(page.getByTestId("env-tab-qa")).toHaveCount(0);
    });

    test("rotate the DEK; existing secrets still decrypt", async ({ page }) => {
      await page.goto(`/projects/${project.id}/settings`);
      await page.getByTestId("rotate-dek").click();
      await page.getByTestId("confirm-accept").click();
      await expectToast(
        page,
        "success",
        /DEK rotated \(v1 → v2\); 1 secrets? re-encrypted/,
      );

      await page.goto(`/projects/${project.id}`);
      const row = page.getByTestId("secret-row-KEEP_ME");
      await row.getByTestId("reveal-toggle").click();
      await expect(row.getByTestId("secret-value")).toHaveText(
        "survives-rotation",
      );
    });

    test("delete the project with typed confirmation", async ({ page }) => {
      await page.goto(`/projects/${project.id}/settings`);
      await page.getByTestId("delete-project").click();

      await expect(page.getByTestId("confirm-accept")).toBeDisabled();
      await page.getByTestId("confirm-input").fill(project.slug);
      await page.getByTestId("confirm-accept").click();
      await expectToast(page, "success", "deleted");

      await page.waitForURL((url) => url.pathname === "/");
      await expect(
        page.getByTestId(`sidebar-project-${project.slug}`),
      ).toHaveCount(0);

      // The old project route is gone.
      await page.goto(`/projects/${project.id}`);
      await expect(
        page.getByText(
          "This project doesn't exist or you don't have access to it.",
        ),
      ).toBeVisible();
    });
  });
