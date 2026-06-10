import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  api,
  createMemberUser,
  createTestApp,
  signUpUser,
  type TestApp,
} from "../../test/testApp";
import { TEST_REDIS_URL } from "../../test/testRedis";
import { createRedis } from "../redis/client";

const redis = createRedis(TEST_REDIS_URL);

beforeAll(async () => {
  await redis.connect();
});

afterAll(() => {
  redis.close();
});

/**
 * RBAC matrix over the project routes. One app/projet per describe block;
 * each member user gets a different membership role.
 */
let ctx: TestApp;
let owner: { cookie: string; userId: string };
let reader: { cookie: string; userId: string };
let writer: { cookie: string; userId: string };
let admin: { cookie: string; userId: string };
let instanceAdmin: { cookie: string; userId: string };
let stranger: { cookie: string; userId: string };
let projectId: string;
let envId: string;

function p(path: string): string {
  return `/api/projects/${projectId}${path}`;
}

function secretsPath(path = ""): string {
  return p(`/environments/${envId}/secrets${path}`);
}

beforeEach(async () => {
  ctx = await createTestApp(redis);
  owner = await signUpUser(ctx.app, "owner");
  reader = await createMemberUser(ctx.app, owner.cookie, "reader");
  writer = await createMemberUser(ctx.app, owner.cookie, "writer");
  admin = await createMemberUser(ctx.app, owner.cookie, "admin");
  instanceAdmin = await createMemberUser(ctx.app, owner.cookie, "iadmin");
  stranger = await createMemberUser(ctx.app, owner.cookie, "stranger");

  // Promote instanceAdmin to instance-level admin (no project membership).
  ctx.db.run('UPDATE "user" SET role = ? WHERE id = ?', [
    "admin",
    instanceAdmin.userId,
  ]);

  const created = await api(ctx.app, "POST", "/api/projects", {
    cookie: owner.cookie,
    body: { name: "RBAC Project" },
  });
  const project = (await created.json()) as {
    id: string;
    environments: Array<{ id: string }>;
  };
  projectId = project.id;
  envId = (project.environments[0] as { id: string }).id;

  for (const [user, role] of [
    [reader, "read"],
    [writer, "write"],
    [admin, "admin"],
  ] as const) {
    const res = await api(ctx.app, "POST", p("/members"), {
      cookie: owner.cookie,
      body: { userId: user.userId, role },
    });
    expect(res.status).toBe(201);
  }

  await api(ctx.app, "PUT", secretsPath(), {
    cookie: owner.cookie,
    body: { secrets: { SEED: "value" } },
  });
});

afterEach(() => {
  ctx.close();
});

describe("read role", () => {
  test("can read secrets including values, and list members", async () => {
    const values = await api(
      ctx.app,
      "GET",
      `${secretsPath()}?include_values=true`,
      { cookie: reader.cookie },
    );
    expect(values.status).toBe(200);
    const body = (await values.json()) as {
      secrets: Array<{ key: string; value: string }>;
    };
    expect(body.secrets[0]?.value).toBe("value");

    const members = await api(ctx.app, "GET", p("/members"), {
      cookie: reader.cookie,
    });
    expect(members.status).toBe(200);
  });

  test("cannot write secrets, manage members, or read version values", async () => {
    const put = await api(ctx.app, "PUT", secretsPath(), {
      cookie: reader.cookie,
      body: { secrets: { X: "y" } },
    });
    expect(put.status).toBe(403);
    expect(await put.json()).toEqual({ error: "forbidden" });

    const addMember = await api(ctx.app, "POST", p("/members"), {
      cookie: reader.cookie,
      body: { userId: stranger.userId, role: "read" },
    });
    expect(addMember.status).toBe(403);

    // Version metadata is fine; values are admin-only.
    const meta = await api(ctx.app, "GET", secretsPath("/SEED/versions"), {
      cookie: reader.cookie,
    });
    expect(meta.status).toBe(200);
    const withValues = await api(
      ctx.app,
      "GET",
      `${secretsPath("/SEED/versions")}?include_values=true`,
      { cookie: reader.cookie },
    );
    expect(withValues.status).toBe(403);
  });
});

describe("write role", () => {
  test("can write and rollback secrets", async () => {
    const put = await api(ctx.app, "PUT", secretsPath(), {
      cookie: writer.cookie,
      body: { secrets: { SEED: "value2" } },
    });
    expect(put.status).toBe(200);

    const rollback = await api(ctx.app, "POST", secretsPath("/SEED/rollback"), {
      cookie: writer.cookie,
      body: { toVersion: 1 },
    });
    expect(rollback.status).toBe(200);
  });

  test("cannot rotate the DEK, create environments, or read version values", async () => {
    const rotate = await api(ctx.app, "POST", p("/rotate-dek"), {
      cookie: writer.cookie,
    });
    expect(rotate.status).toBe(403);

    const env = await api(ctx.app, "POST", p("/environments"), {
      cookie: writer.cookie,
      body: { name: "QA", slug: "qa" },
    });
    expect(env.status).toBe(403);

    const withValues = await api(
      ctx.app,
      "GET",
      `${secretsPath("/SEED/versions")}?include_values=true`,
      { cookie: writer.cookie },
    );
    expect(withValues.status).toBe(403);
  });
});

describe("admin member", () => {
  test("can do everything project-scoped", async () => {
    expect(
      (
        await api(
          ctx.app,
          "GET",
          `${secretsPath("/SEED/versions")}?include_values=true`,
          {
            cookie: admin.cookie,
          },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await api(ctx.app, "POST", p("/environments"), {
          cookie: admin.cookie,
          body: { name: "QA", slug: "qa" },
        })
      ).status,
    ).toBe(201);
    expect(
      (await api(ctx.app, "POST", p("/rotate-dek"), { cookie: admin.cookie }))
        .status,
    ).toBe(200);
    expect(
      (
        await api(ctx.app, "PATCH", p(""), {
          cookie: admin.cookie,
          body: { name: "Renamed" },
        })
      ).status,
    ).toBe(200);
  });
});

describe("non-member", () => {
  test("gets 404 (not 403) on project, secrets, and members routes", async () => {
    for (const [method, path, body] of [
      ["GET", p(""), undefined],
      ["GET", secretsPath(), undefined],
      ["GET", p("/members"), undefined],
      ["PUT", secretsPath(), { secrets: { A: "b" } }],
      ["POST", p("/rotate-dek"), undefined],
    ] as const) {
      const res = await api(ctx.app, method, path, {
        cookie: stranger.cookie,
        body,
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});

describe("instance admin without membership", () => {
  test("has full project access", async () => {
    expect(
      (await api(ctx.app, "GET", p(""), { cookie: instanceAdmin.cookie }))
        .status,
    ).toBe(200);
    expect(
      (
        await api(ctx.app, "PUT", secretsPath(), {
          cookie: instanceAdmin.cookie,
          body: { secrets: { FROM_IADMIN: "x" } },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(ctx.app, "POST", p("/rotate-dek"), {
          cookie: instanceAdmin.cookie,
        })
      ).status,
    ).toBe(200);
  });
});

describe("unauthenticated", () => {
  test("gets 401 on all project routes", async () => {
    for (const [method, path] of [
      ["GET", "/api/projects"],
      ["POST", "/api/projects"],
      ["GET", p("")],
      ["GET", secretsPath()],
      ["GET", p("/members")],
    ] as const) {
      const res = await api(ctx.app, method, path, {
        body: method === "POST" ? { name: "X" } : undefined,
      });
      expect(res.status).toBe(401);
    }
  });
});
