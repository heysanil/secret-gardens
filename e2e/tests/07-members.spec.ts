/**
 * Membership management and RBAC as seen through the UI: the picker, role
 * badges for read members, write promotion, and the last-admin guard.
 */
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  createProject,
  createUser,
  envBySlug,
  newOwnerContext,
  type ProjectDetail,
  putSecret,
} from "../helpers/api";
import { MEMBER_PASSWORD, OWNER_STATE, unique } from "../helpers/constants";
import { expectToast, signIn } from "../helpers/ui";

test.use({ storageState: OWNER_STATE });

let api: APIRequestContext;
let project: ProjectDetail;
let ownerId: string;
let user2: { id: string; email: string };

test.beforeAll(async () => {
  api = await newOwnerContext();
  ownerId = ((await (await api.get("/api/me")).json()) as { userId: string })
    .userId;
  user2 = await createUser(
    api,
    `${unique("user2")}@e2e.test`,
    "User Two",
    MEMBER_PASSWORD,
  );
  project = await createProject(api, unique("Members UI"));
  await putSecret(
    api,
    project.id,
    envBySlug(project, "dev").id,
    "SEED_KEY",
    "seed-value",
  );
});

test.afterAll(async () => {
  await api.dispose();
});

test.describe
  .serial("members & RBAC", () => {
    test("owner adds user2 as read via the picker", async ({ page }) => {
      await page.goto(`/projects/${project.id}/members`);

      // The owner's own membership row exposes no role select / remove.
      const ownerRow = page.getByTestId(`member-row-${ownerId}`);
      await expect(ownerRow).toBeVisible();
      await expect(ownerRow).toContainText("(you)");
      await expect(ownerRow.getByTestId("member-role-select")).toHaveCount(0);
      await expect(ownerRow.getByTestId("member-remove")).toHaveCount(0);

      await page.getByTestId("add-member-search").fill(user2.email);
      await page.getByTestId(`add-member-option-${user2.email}`).click();
      await page.getByTestId("add-member-submit").click();

      await expectToast(page, "success", "User Two added as read");
      const row = page.getByTestId(`member-row-${user2.id}`);
      await expect(row).toBeVisible();
      await expect(row.getByTestId("member-role-select")).toHaveValue("read");
    });

    test("read member sees the project read-only", async ({ browser }) => {
      // Explicitly empty storage: browser.newContext() would otherwise
      // inherit the owner storageState from test.use above.
      const context = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      const page = await context.newPage();
      await signIn(page, user2.email, MEMBER_PASSWORD);

      await page.getByTestId(`sidebar-project-${project.slug}`).click();
      await page.waitForURL(`**/projects/${project.id}`);
      await expect(page.getByTestId("secret-row-SEED_KEY")).toBeVisible();

      // No write affordances, no settings section.
      await expect(page.getByTestId("add-secret-key")).toHaveCount(0);
      await expect(
        page.getByTestId("secret-row-SEED_KEY").getByTestId("secret-delete"),
      ).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);

      // Current values may be revealed by read members…
      const row = page.getByTestId("secret-row-SEED_KEY");
      await row.getByTestId("reveal-toggle").click();
      await expect(row.getByTestId("secret-value")).toHaveText("seed-value");

      // …but historical values are admin-only: no reveal toggle, no rollback.
      await row.getByTestId("secret-history").click();
      const drawer = page.getByTestId("versions-drawer");
      await expect(drawer.getByTestId("version-row-1")).toBeVisible();
      await expect(drawer.getByTestId("versions-reveal-toggle")).toHaveCount(0);
      await expect(drawer.getByTestId("version-rollback")).toHaveCount(0);

      await context.close();
    });

    test("owner promotes user2 to write; user2 can add a secret", async ({
      page,
      browser,
    }) => {
      await page.goto(`/projects/${project.id}/members`);
      await page
        .getByTestId(`member-row-${user2.id}`)
        .getByTestId("member-role-select")
        .selectOption("write");
      await expectToast(page, "success", "Role changed to write");

      // Explicitly empty storage: browser.newContext() would otherwise
      // inherit the owner storageState from test.use above.
      const context = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      const user2Page = await context.newPage();
      await signIn(user2Page, user2.email, MEMBER_PASSWORD);
      await user2Page.goto(`/projects/${project.id}`);
      await user2Page.getByTestId("add-secret-key").fill("U2_KEY");
      await user2Page.getByTestId("add-secret-value").fill("written-by-user2");
      await user2Page.getByTestId("add-secret-submit").click();
      await expectToast(user2Page, "success", "U2_KEY created");
      await expect(user2Page.getByTestId("secret-row-U2_KEY")).toBeVisible();
      await context.close();
    });

    test("last-admin guard blocks demoting or removing the sole admin", async ({
      page,
      browser,
    }) => {
      // Owner promotes user2 to admin, then user2 demotes the owner — leaving
      // user2 as the project's only explicit admin.
      await page.goto(`/projects/${project.id}/members`);
      await page
        .getByTestId(`member-row-${user2.id}`)
        .getByTestId("member-role-select")
        .selectOption("admin");
      await expectToast(page, "success", "Role changed to admin");

      // Explicitly empty storage: browser.newContext() would otherwise
      // inherit the owner storageState from test.use above.
      const context = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      const user2Page = await context.newPage();
      await signIn(user2Page, user2.email, MEMBER_PASSWORD);
      await user2Page.goto(`/projects/${project.id}/members`);
      await user2Page
        .getByTestId(`member-row-${ownerId}`)
        .getByTestId("member-role-select")
        .selectOption("write");
      await expectToast(user2Page, "success", "Role changed to write");
      await context.close();

      // The owner (implicit admin via instance role) now hits the guard when
      // trying to demote or remove user2, the last explicit admin.
      await page.goto(`/projects/${project.id}/members`);
      const row = page.getByTestId(`member-row-${user2.id}`);
      await row.getByTestId("member-role-select").selectOption("read");
      await expectToast(
        page,
        "error",
        "Every project needs at least one admin — promote someone else first.",
      );
      await expect(row.getByTestId("member-role-select")).toHaveValue("admin");

      await row.getByTestId("member-remove").click();
      await page.getByTestId("confirm-accept").click();
      await expectToast(
        page,
        "error",
        "Every project needs at least one admin — promote someone else first.",
      );
      await expect(row).toBeVisible();
    });
  });
