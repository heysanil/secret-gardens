import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import {
  api,
  createMemberUser,
  createTestApp,
  signUpUser,
  type TestApp,
} from "../../test/testApp";
import { TEST_REDIS_URL } from "../../test/testRedis";
import { createRedis, type RedisLike } from "../redis/client";
import { createSecretStore } from "../redis/secretStore";
import { createDekService, type DekService } from "../services/dekService";
import { createSecretService } from "../services/secretService";
import { deriveProjectSlug, projectsRoutes } from "./projects";

const redis = createRedis(TEST_REDIS_URL);

beforeAll(async () => {
  await redis.connect();
});

afterAll(() => {
  redis.close();
});

async function scanKeys(client: RedisLike, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const reply = (await client.send("SCAN", [
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      "1000",
    ])) as [string, string[]];
    cursor = reply[0];
    found.push(...reply[1]);
  } while (cursor !== "0");
  return found;
}

interface ProjectDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  role: string;
  environments: Array<{
    id: string;
    name: string;
    slug: string;
    position: number;
  }>;
}

async function createProject(
  ctx: TestApp,
  cookie: string,
  body: Record<string, unknown>,
): Promise<ProjectDetail> {
  const res = await api(ctx.app, "POST", "/api/projects", { cookie, body });
  expect(res.status).toBe(201);
  return (await res.json()) as ProjectDetail;
}

describe("deriveProjectSlug", () => {
  test("derives clean slugs from display names", () => {
    expect(deriveProjectSlug("My App!")).toBe("my-app");
    expect(deriveProjectSlug("  Spaces   Everywhere  ")).toBe(
      "spaces-everywhere",
    );
    expect(deriveProjectSlug("Already-good-1")).toBe("already-good-1");
    expect(deriveProjectSlug("!!!")).toBe("");
  });
});

describe("project lifecycle", () => {
  test("create → secrets → versions → rollback → rotate → delete, with full audit trail", async () => {
    const ctx = await createTestApp(redis);
    const owner = await signUpUser(ctx.app, "owner");

    // --- create ---
    const project = await createProject(ctx, owner.cookie, {
      name: "My App!",
      description: "lifecycle test",
    });
    expect(project.slug).toBe("my-app");
    expect(project.role).toBe("admin");
    expect(project.environments.map((e) => [e.slug, e.position])).toEqual([
      ["dev", 0],
      ["staging", 1],
      ["prod", 2],
    ]);
    const dev = project.environments[0] as { id: string };

    // project_keys: a single active v1 row.
    const keyRows = ctx.db
      .query<{ version: number; status: string }, [string]>(
        "SELECT version, status FROM project_keys WHERE project_id = ?",
      )
      .all(project.id);
    expect(keyRows).toEqual([{ version: 1, status: "active" }]);

    // creator membership: admin.
    const membership = ctx.db
      .query<{ role: string }, [string, string]>(
        "SELECT role FROM project_memberships WHERE project_id = ? AND user_id = ?",
      )
      .get(project.id, owner.userId);
    expect(membership?.role).toBe("admin");

    // --- bulk PUT ---
    const putRes = await api(
      ctx.app,
      "PUT",
      `/api/projects/${project.id}/environments/${dev.id}/secrets`,
      {
        cookie: owner.cookie,
        body: { secrets: { API_KEY: "k-1", DB_URL: "postgres://x" } },
      },
    );
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({
      created: ["API_KEY", "DB_URL"],
      updated: [],
      deleted: [],
      unchanged: 0,
    });

    // --- GET with values ---
    const getRes = await api(
      ctx.app,
      "GET",
      `/api/projects/${project.id}/environments/${dev.id}/secrets?include_values=true`,
      { cookie: owner.cookie },
    );
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as {
      secrets: Array<{ key: string; value: string; version: number }>;
    };
    expect(got.secrets.map((s) => [s.key, s.value])).toEqual([
      ["API_KEY", "k-1"],
      ["DB_URL", "postgres://x"],
    ]);

    // --- single PUT update ---
    const updateRes = await api(
      ctx.app,
      "PUT",
      `/api/projects/${project.id}/environments/${dev.id}/secrets/API_KEY`,
      { cookie: owner.cookie, body: { value: "k-2" } },
    );
    expect(updateRes.status).toBe(200);
    expect(await updateRes.json()).toEqual({
      key: "API_KEY",
      version: 2,
      op: "update",
    });

    // --- versions list ---
    const versionsRes = await api(
      ctx.app,
      "GET",
      `/api/projects/${project.id}/environments/${dev.id}/secrets/API_KEY/versions`,
      { cookie: owner.cookie },
    );
    expect(versionsRes.status).toBe(200);
    const { versions } = (await versionsRes.json()) as {
      versions: Array<{ version: number; op: string }>;
    };
    expect(versions.map((v) => [v.version, v.op])).toEqual([
      [2, "update"],
      [1, "create"],
    ]);

    // --- rollback to v1 ---
    const rollbackRes = await api(
      ctx.app,
      "POST",
      `/api/projects/${project.id}/environments/${dev.id}/secrets/API_KEY/rollback`,
      { cookie: owner.cookie, body: { toVersion: 1 } },
    );
    expect(rollbackRes.status).toBe(200);
    expect(await rollbackRes.json()).toEqual({ version: 3 });

    const afterRollback = await api(
      ctx.app,
      "GET",
      `/api/projects/${project.id}/environments/${dev.id}/secrets?include_values=true`,
      { cookie: owner.cookie },
    );
    const rolled = (await afterRollback.json()) as {
      secrets: Array<{ key: string; value: string; version: number }>;
    };
    expect(rolled.secrets.find((s) => s.key === "API_KEY")?.value).toBe("k-1");
    expect(rolled.secrets.find((s) => s.key === "API_KEY")?.version).toBe(3);

    // --- rotate DEK ---
    const rotateRes = await api(
      ctx.app,
      "POST",
      `/api/projects/${project.id}/rotate-dek`,
      { cookie: owner.cookie },
    );
    expect(rotateRes.status).toBe(200);
    expect(await rotateRes.json()).toEqual({
      oldVersion: 1,
      newVersion: 2,
      secretsRewritten: 2,
    });

    // --- audit sweep: per-project stream holds the expected sequence ---
    const page = await ctx.audit.readAudit(
      { projectId: project.id },
      { limit: 100 },
    );
    const actions = page.entries.map((e) => e.action).reverse(); // oldest first
    expect(actions).toEqual([
      "project.create",
      "secret.create", // API_KEY
      "secret.create", // DB_URL
      "secrets.read",
      "secret.update",
      "secret.rollback",
      "secrets.read",
      "dek.rotate",
    ]);
    const rollbackEntry = page.entries.find(
      (e) => e.action === "secret.rollback",
    );
    expect(rollbackEntry?.key).toBe("API_KEY");
    expect(rollbackEntry?.toVersion).toBe("1");
    expect(rollbackEntry?.version).toBe("3");

    // --- delete project ---
    const deleteRes = await api(
      ctx.app,
      "DELETE",
      `/api/projects/${project.id}`,
      {
        cookie: owner.cookie,
      },
    );
    expect(deleteRes.status).toBe(200);

    // Redis: secrets, versions, counters, and the project audit stream gone.
    expect(await scanKeys(redis, `secrets:${project.id}:*`)).toEqual([]);
    expect(await scanKeys(redis, `secretver:${project.id}:*`)).toEqual([]);
    expect(await scanKeys(redis, `secretvctr:${project.id}:*`)).toEqual([]);
    expect(await scanKeys(redis, `audit:${project.id}`)).toEqual([]);

    // SQLite: cascade removed envs, memberships, keys.
    for (const table of [
      "projects",
      "environments",
      "project_memberships",
      "project_keys",
    ]) {
      const count = ctx.db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE ${
            table === "projects" ? "id" : "project_id"
          } = ?`,
        )
        .get(project.id);
      expect(count?.n).toBe(0);
    }

    // Instance stream keeps the full record.
    const instancePage = await ctx.audit.readAudit("instance", { limit: 100 });
    const forProject = instancePage.entries.filter(
      (e) => e.projectId === project.id,
    );
    const instanceActions = forProject.map((e) => e.action).reverse();
    expect(instanceActions).toEqual([
      "project.create",
      "dek.rotate",
      "project.delete",
    ]);
    expect(forProject.find((e) => e.action === "project.delete")?.slug).toBe(
      "my-app",
    );

    ctx.close();
  });
});

describe("POST /api/projects slug handling", () => {
  test("explicit invalid slug → 422; duplicate slug → 409", async () => {
    const ctx = await createTestApp(redis);
    const owner = await signUpUser(ctx.app, "owner");

    const bad = await api(ctx.app, "POST", "/api/projects", {
      cookie: owner.cookie,
      body: { name: "Bad", slug: "-leading-hyphen" },
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: "invalid_slug" });

    const badName = await api(ctx.app, "POST", "/api/projects", {
      cookie: owner.cookie,
      body: { name: "!!!" }, // derives to ''
    });
    expect(badName.status).toBe(422);

    await createProject(ctx, owner.cookie, { name: "Taken", slug: "taken" });
    const dup = await api(ctx.app, "POST", "/api/projects", {
      cookie: owner.cookie,
      body: { name: "Other", slug: "taken" },
    });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "duplicate_slug" });
    ctx.close();
  });

  test("any authenticated user may create; creator becomes project admin", async () => {
    const ctx = await createTestApp(redis);
    const owner = await signUpUser(ctx.app, "owner");
    const member = await createMemberUser(ctx.app, owner.cookie, "member");

    const project = await createProject(ctx, member.cookie, {
      name: "Member Project",
    });
    expect(project.role).toBe("admin");
    const row = ctx.db
      .query<{ role: string }, [string, string]>(
        "SELECT role FROM project_memberships WHERE project_id = ? AND user_id = ?",
      )
      .get(project.id, member.userId);
    expect(row?.role).toBe("admin");
    ctx.close();
  });
});

describe("GET /api/projects", () => {
  test("members see joined projects; instance admins see all", async () => {
    const ctx = await createTestApp(redis);
    const owner = await signUpUser(ctx.app, "owner");
    const member = await createMemberUser(ctx.app, owner.cookie, "member");

    const p1 = await createProject(ctx, owner.cookie, { name: "Owner Only" });
    const p2 = await createProject(ctx, member.cookie, { name: "Member Made" });

    const ownerList = await api(ctx.app, "GET", "/api/projects", {
      cookie: owner.cookie,
    });
    const ownerProjects = (await ownerList.json()) as Array<{
      id: string;
      role: string;
      environmentCount: number;
    }>;
    expect(ownerProjects.map((p) => p.id).sort()).toEqual(
      [p1.id, p2.id].sort(),
    );
    expect(ownerProjects.every((p) => p.role === "admin")).toBe(true);
    expect(ownerProjects[0]?.environmentCount).toBe(3);

    const memberList = await api(ctx.app, "GET", "/api/projects", {
      cookie: member.cookie,
    });
    const memberProjects = (await memberList.json()) as Array<{ id: string }>;
    expect(memberProjects.map((p) => p.id)).toEqual([p2.id]);
    ctx.close();
  });
});

describe("PATCH /api/projects/:projectId", () => {
  test("updates name/description and audits project.update", async () => {
    const ctx = await createTestApp(redis);
    const owner = await signUpUser(ctx.app, "owner");
    const project = await createProject(ctx, owner.cookie, { name: "Before" });

    const res = await api(ctx.app, "PATCH", `/api/projects/${project.id}`, {
      cookie: owner.cookie,
      body: { name: "After", description: "now described" },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as ProjectDetail;
    expect(updated.name).toBe("After");
    expect(updated.description).toBe("now described");
    expect(updated.slug).toBe(project.slug); // slug immutable

    const page = await ctx.audit.readAudit({ projectId: project.id }, {});
    expect(page.entries[0]?.action).toBe("project.update");
    ctx.close();
  });
});

describe("POST /api/projects/:projectId/rotate-dek", () => {
  test("rotates keys, rewrites current records in place, history intact", async () => {
    const ctx = await createTestApp(redis);
    const owner = await signUpUser(ctx.app, "owner");
    const project = await createProject(ctx, owner.cookie, { name: "Rotor" });
    const dev = project.environments[0] as { id: string };
    const base = `/api/projects/${project.id}/environments/${dev.id}/secrets`;

    await api(ctx.app, "PUT", base, {
      cookie: owner.cookie,
      body: { secrets: { A: "alpha", B: "beta" } },
    });
    await api(ctx.app, "PUT", `${base}/A`, {
      cookie: owner.cookie,
      body: { value: "alpha-2" },
    });

    const versionCountBefore = (await redis.send("HLEN", [
      `secretver:${project.id}:${dev.id}:A`,
    ])) as number;

    const res = await api(
      ctx.app,
      "POST",
      `/api/projects/${project.id}/rotate-dek`,
      { cookie: owner.cookie },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      oldVersion: 1,
      newVersion: 2,
      secretsRewritten: 2,
    });

    // project_keys: v1 retired, v2 active.
    const rows = ctx.db
      .query<{ version: number; status: string }, [string]>(
        "SELECT version, status FROM project_keys WHERE project_id = ? ORDER BY version",
      )
      .all(project.id);
    expect(rows).toEqual([
      { version: 1, status: "retired" },
      { version: 2, status: "active" },
    ]);

    // Raw redis: every current record now dekV 2, current.v untouched.
    for (const [key, v] of [
      ["A", 2],
      ["B", 1],
    ] as const) {
      const raw = await redis.hget(`secrets:${project.id}:${dev.id}`, key);
      const record = JSON.parse(raw as string) as { v: number; dekV: number };
      expect(record.dekV).toBe(2);
      expect(record.v).toBe(v);
    }

    // No version spam.
    const versionCountAfter = (await redis.send("HLEN", [
      `secretver:${project.id}:${dev.id}:A`,
    ])) as number;
    expect(versionCountAfter).toBe(versionCountBefore);

    // Values still decrypt; old versions still decrypt (retired DEK path).
    const values = await api(ctx.app, "GET", `${base}?include_values=true`, {
      cookie: owner.cookie,
    });
    const { secrets } = (await values.json()) as {
      secrets: Array<{ key: string; value: string }>;
    };
    expect(secrets.map((s) => [s.key, s.value])).toEqual([
      ["A", "alpha-2"],
      ["B", "beta"],
    ]);

    const history = await api(
      ctx.app,
      "GET",
      `${base}/A/versions?include_values=true`,
      { cookie: owner.cookie },
    );
    const { versions } = (await history.json()) as {
      versions: Array<{ version: number; value: string }>;
    };
    expect(versions.map((v) => [v.version, v.value])).toEqual([
      [2, "alpha-2"],
      [1, "alpha"],
    ]);

    // Cache invalidation: post-rotation writes use the new DEK.
    await api(ctx.app, "PUT", `${base}/NEW`, {
      cookie: owner.cookie,
      body: { value: "fresh" },
    });
    const newRaw = await redis.hget(`secrets:${project.id}:${dev.id}`, "NEW");
    expect((JSON.parse(newRaw as string) as { dekV: number }).dekV).toBe(2);

    ctx.close();
  });
});

describe("POST /api/projects DEK creation failure", () => {
  /**
   * Builds a parallel app over the same db/auth/audit as `ctx`, but with a
   * dekService whose createProjectDek always throws. The error hook proves
   * the failure is HANDLED in the route (our JSON 500 contract) rather
   * than rethrown into Elysia's default error rendering.
   */
  function buildFailingApp(ctx: TestApp, db: Database) {
    const secretStore = createSecretStore(redis);
    const realDek = createDekService({
      db: ctx.db,
      masterKey: ctx.config.masterKey,
    });
    const dekService: DekService = {
      ...realDek,
      createProjectDek: () => {
        throw new Error("dek wrap failed (test)");
      },
    };
    const secretService = createSecretService({ dekService, secretStore });
    const captured: { error: unknown } = { error: undefined };
    const app = new Elysia()
      .onError(({ error }) => {
        captured.error = error;
      })
      .use(
        projectsRoutes({
          db,
          auth: ctx.auth,
          audit: ctx.audit,
          redis,
          dekService,
          secretService,
          secretStore,
        }),
      );
    return { app, captured };
  }

  test("deletes the project row and returns a handled 500 internal_error", async () => {
    const ctx = await createTestApp(redis);
    const owner = await signUpUser(ctx.app, "owner");
    const { app, captured } = buildFailingApp(ctx, ctx.db);

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.handle(
        new Request("http://localhost/api/projects", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: owner.cookie,
          },
          body: JSON.stringify({ name: "Doomed", slug: "doomed" }),
        }),
      );
      // The failure is handled in-route: our JSON error contract, not
      // Elysia's default error rendering — nothing reaches the error hook.
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "internal_error" });
      expect(captured.error).toBeUndefined();

      // The ORIGINAL DEK error was logged with the project id.
      const logged = errorSpy.mock.calls.find((call) =>
        String(call[0]).includes("could not provision a DEK"),
      );
      expect(logged).toBeDefined();
      expect((logged?.[1] as Error).message).toBe("dek wrap failed (test)");
    } finally {
      errorSpy.mockRestore();
    }

    // Compensating delete removed the row (and, via cascade, envs/membership).
    expect(
      ctx.db.query("SELECT id FROM projects WHERE slug = 'doomed'").get(),
    ).toBeNull();
    expect(
      ctx.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM environments e JOIN projects p ON p.id = e.project_id WHERE p.slug = 'doomed'",
        )
        .get()?.n,
    ).toBe(0);
    ctx.close();
  });

  test("a failing compensating delete logs the orphan and still returns the handled 500", async () => {
    const ctx = await createTestApp(redis);
    const owner = await signUpUser(ctx.app, "owner");

    // Proxy the db so ONLY the compensating delete throws.
    const failingDb = new Proxy(ctx.db, {
      get(target, prop) {
        if (prop === "run") {
          return (sql: string, params?: unknown[]) => {
            if (sql.startsWith("DELETE FROM projects")) {
              throw new Error("cleanup failed (test)");
            }
            return target.run(sql, params as never);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Database;

    const { app, captured } = buildFailingApp(ctx, failingDb);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.handle(
        new Request("http://localhost/api/projects", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: owner.cookie,
          },
          body: JSON.stringify({ name: "Orphan", slug: "orphan" }),
        }),
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal_error" });
      // Handled in-route: nothing reaches the error hook even when the
      // compensating delete ALSO fails.
      expect(captured.error).toBeUndefined();

      // The cleanup failure was logged with the orphaned project id.
      const orphan = ctx.db
        .query<{ id: string }, []>(
          "SELECT id FROM projects WHERE slug = 'orphan'",
        )
        .get();
      expect(orphan).not.toBeNull();
      const cleanupLog = errorSpy.mock.calls.find((call) =>
        String(call[0]).includes("failed to clean up project"),
      );
      expect(cleanupLog).toBeDefined();
      expect(String(cleanupLog?.[0])).toContain(orphan?.id as string);
      expect((cleanupLog?.[1] as Error).message).toBe("cleanup failed (test)");

      // …and the ORIGINAL DEK error was logged too — not masked.
      const dekLog = errorSpy.mock.calls.find((call) =>
        String(call[0]).includes("could not provision a DEK"),
      );
      expect(dekLog).toBeDefined();
      expect((dekLog?.[1] as Error).message).toBe("dek wrap failed (test)");
    } finally {
      errorSpy.mockRestore();
    }
    ctx.close();
  });
});
