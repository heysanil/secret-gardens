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
 * End-to-end authorization matrix for service principals: every call is a
 * real Bearer round-trip through app.handle.
 */
let ctx: TestApp;
let owner: { cookie: string; userId: string };
let projectId: string;
let envA: string;
let envB: string;
let otherProjectId: string;
let otherEnvId: string;
let readToken: string;
let writeToken: string;
let writeTokenId: string;
let envScopedToken: string;

function p(path = ""): string {
  return `/api/projects/${projectId}${path}`;
}

function secretsPath(envId: string, path = ""): string {
  return p(`/environments/${envId}/secrets${path}`);
}

async function mintToken(body: Record<string, unknown>): Promise<{
  id: string;
  token: string;
}> {
  const res = await api(ctx.app, "POST", p("/tokens"), {
    cookie: owner.cookie,
    body,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string };
}

beforeEach(async () => {
  ctx = await createTestApp(redis);
  owner = await signUpUser(ctx.app, "owner");

  const created = await api(ctx.app, "POST", "/api/projects", {
    cookie: owner.cookie,
    body: { name: "Service Project" },
  });
  const project = (await created.json()) as {
    id: string;
    environments: Array<{ id: string }>;
  };
  projectId = project.id;
  envA = (project.environments[0] as { id: string }).id;
  envB = (project.environments[1] as { id: string }).id;

  const other = await api(ctx.app, "POST", "/api/projects", {
    cookie: owner.cookie,
    body: { name: "Other Project" },
  });
  const otherProject = (await other.json()) as {
    id: string;
    environments: Array<{ id: string }>;
  };
  otherProjectId = otherProject.id;
  otherEnvId = (otherProject.environments[0] as { id: string }).id;

  // Seed secrets in both envs of the service project.
  for (const envId of [envA, envB]) {
    await api(ctx.app, "PUT", secretsPath(envId), {
      cookie: owner.cookie,
      body: { secrets: { SEED: "value", OTHER: "x" } },
    });
  }

  readToken = (await mintToken({ name: "ro", scope: "read" })).token;
  const write = await mintToken({ name: "rw", scope: "read_write" });
  writeToken = write.token;
  writeTokenId = write.id;
  envScopedToken = (
    await mintToken({
      name: "envA only",
      scope: "read_write",
      environmentIds: [envA],
    })
  ).token;
});

afterEach(() => {
  ctx.close();
});

describe("read-scope token", () => {
  test("GET secrets 200, include_values returns values and audits the service actor", async () => {
    const list = await api(ctx.app, "GET", secretsPath(envA), {
      bearer: readToken,
    });
    expect(list.status).toBe(200);

    const values = await api(
      ctx.app,
      "GET",
      `${secretsPath(envA)}?include_values=true`,
      { bearer: readToken },
    );
    expect(values.status).toBe(200);
    const body = (await values.json()) as {
      secrets: Array<{ key: string; value?: string }>;
    };
    expect(body.secrets.find((s) => s.key === "SEED")?.value).toBe("value");

    const page = await ctx.audit.readAudit(
      { projectId },
      { action: "secrets.read" },
    );
    const entry = page.entries.find((e) => e.actorType === "service_token");
    expect(entry).toBeDefined();
    expect(entry?.envId).toBe(envA);
  });

  test("all secrets writes are 403 forbidden", async () => {
    const bulk = await api(ctx.app, "PUT", secretsPath(envA), {
      bearer: readToken,
      body: { secrets: { NEW: "v" } },
    });
    expect(bulk.status).toBe(403);

    const single = await api(ctx.app, "PUT", secretsPath(envA, "/SEED"), {
      bearer: readToken,
      body: { value: "changed" },
    });
    expect(single.status).toBe(403);

    const del = await api(ctx.app, "DELETE", secretsPath(envA, "/SEED"), {
      bearer: readToken,
    });
    expect(del.status).toBe(403);

    const rollback = await api(
      ctx.app,
      "POST",
      secretsPath(envA, "/SEED/rollback"),
      { bearer: readToken, body: { toVersion: 1 } },
    );
    expect(rollback.status).toBe(403);

    // Nothing changed.
    const seed = await api(
      ctx.app,
      "GET",
      `${secretsPath(envA)}?include_values=true`,
      { cookie: owner.cookie },
    );
    const body = (await seed.json()) as {
      secrets: Array<{ key: string; value?: string }>;
    };
    expect(body.secrets.find((s) => s.key === "SEED")?.value).toBe("value");
    expect(body.secrets.some((s) => s.key === "NEW")).toBe(false);
  });
});

describe("read_write-scope token", () => {
  test("all secrets ops succeed and audit as service_token", async () => {
    const bulk = await api(ctx.app, "PUT", secretsPath(envA), {
      bearer: writeToken,
      body: { secrets: { BULK: "1" } },
    });
    expect(bulk.status).toBe(200);

    const single = await api(ctx.app, "PUT", secretsPath(envA, "/SEED"), {
      bearer: writeToken,
      body: { value: "v2" },
    });
    expect(single.status).toBe(200);
    expect(await single.json()).toEqual({
      key: "SEED",
      version: 2,
      op: "update",
    });

    const rollback = await api(
      ctx.app,
      "POST",
      secretsPath(envA, "/SEED/rollback"),
      { bearer: writeToken, body: { toVersion: 1 } },
    );
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toEqual({ version: 3 });

    const del = await api(ctx.app, "DELETE", secretsPath(envA, "/OTHER"), {
      bearer: writeToken,
    });
    expect(del.status).toBe(200);

    const read = await api(ctx.app, "GET", secretsPath(envA), {
      bearer: writeToken,
    });
    expect(read.status).toBe(200);

    // Write-path audit entries carry the service actor.
    const auditPage = await ctx.audit.readAudit(
      { projectId },
      { action: "secret.update" },
    );
    const update = auditPage.entries.find((e) => e.key === "SEED");
    expect(update?.actorType).toBe("service_token");
    expect(update?.actorId).toBe(writeTokenId);

    // ...and so does the stored version history (raw Redis state).
    const versions = (await redis.hgetall(
      `secretver:${projectId}:${envA}:SEED`,
    )) as Record<string, string>;
    const v2 = JSON.parse(versions["2"] ?? "{}") as {
      actorType: string;
      actorId: string;
    };
    expect(v2.actorType).toBe("service_token");
    expect(v2.actorId).toBe(writeTokenId);
  });
});

describe("routes both scopes must never reach (own project → 403)", () => {
  const cases: Array<[string, string, string, unknown?]> = [
    [
      "GET",
      "versions metadata",
      "/environments/__ENVA__/secrets/SEED/versions",
    ],
    [
      "GET",
      "versions with values",
      "/environments/__ENVA__/secrets/SEED/versions?include_values=true",
    ],
    ["GET", "audit", "/audit"],
    ["GET", "members", "/members"],
    ["GET", "tokens list", "/tokens"],
    ["POST", "rotate-dek", "/rotate-dek"],
    ["POST", "env create", "/environments", { name: "X", slug: "x" }],
    ["PATCH", "project update", "", { name: "Renamed" }],
    ["DELETE", "project delete", ""],
  ];

  for (const [method, label, path, body] of cases) {
    test(`${label} → 403 for read and read_write tokens`, async () => {
      for (const bearer of [readToken, writeToken]) {
        const res = await api(
          ctx.app,
          method,
          p(path.replace("__ENVA__", envA)),
          body === undefined ? { bearer } : { bearer, body },
        );
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "forbidden" });
      }
    });
  }

  test("project list → 403, /api/me and /api/me/tokens → 403", async () => {
    for (const bearer of [readToken, writeToken]) {
      for (const path of ["/api/projects", "/api/me", "/api/me/tokens"]) {
        const res = await api(ctx.app, "GET", path, { bearer });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "forbidden" });
      }
    }
  });
});

describe("project detail exception", () => {
  test("unscoped token gets a filtered detail with all environments", async () => {
    const res = await api(ctx.app, "GET", p(), { bearer: writeToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Exact filtered shape: no role, description, or timestamps.
    expect(Object.keys(body).sort()).toEqual([
      "environments",
      "id",
      "name",
      "slug",
    ]);
    expect(body.id).toBe(projectId);
    const envs = body.environments as Array<{ id: string }>;
    expect(envs.map((e) => e.id)).toContain(envA);
    expect(envs.map((e) => e.id)).toContain(envB);
    expect(envs).toHaveLength(3);
  });

  test("env-scoped token sees only its environments", async () => {
    const res = await api(ctx.app, "GET", p(), { bearer: envScopedToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      environments: Array<{ id: string }>;
    };
    expect(body.environments.map((e) => e.id)).toEqual([envA]);
  });
});

describe("environment scoping", () => {
  test("scoped token operates in envA but gets 403 in envB", async () => {
    const readA = await api(ctx.app, "GET", secretsPath(envA), {
      bearer: envScopedToken,
    });
    expect(readA.status).toBe(200);
    const writeA = await api(ctx.app, "PUT", secretsPath(envA, "/SCOPED"), {
      bearer: envScopedToken,
      body: { value: "ok" },
    });
    expect(writeA.status).toBe(200);

    const readB = await api(ctx.app, "GET", secretsPath(envB), {
      bearer: envScopedToken,
    });
    expect(readB.status).toBe(403);
    const writeB = await api(ctx.app, "PUT", secretsPath(envB, "/SCOPED"), {
      bearer: envScopedToken,
      body: { value: "nope" },
    });
    expect(writeB.status).toBe(403);
  });

  test("unscoped (null environmentIds) token operates in every env", async () => {
    for (const envId of [envA, envB]) {
      const read = await api(ctx.app, "GET", secretsPath(envId), {
        bearer: writeToken,
      });
      expect(read.status).toBe(200);
      const write = await api(ctx.app, "PUT", secretsPath(envId, "/ANY"), {
        bearer: writeToken,
        body: { value: "v" },
      });
      expect(write.status).toBe(200);
    }
  });

  test("an env from another project in the path → 404", async () => {
    const res = await api(ctx.app, "GET", secretsPath(otherEnvId), {
      bearer: writeToken,
    });
    expect(res.status).toBe(404);
  });
});

describe("other projects (existence rule)", () => {
  test("every route of another project → 404, never 403", async () => {
    const calls: Array<[string, string, unknown?]> = [
      ["GET", `/api/projects/${otherProjectId}`],
      [
        "GET",
        `/api/projects/${otherProjectId}/environments/${otherEnvId}/secrets`,
      ],
      [
        "PUT",
        `/api/projects/${otherProjectId}/environments/${otherEnvId}/secrets`,
        { secrets: { A: "1" } },
      ],
      ["GET", `/api/projects/${otherProjectId}/tokens`],
      ["GET", `/api/projects/${otherProjectId}/audit`],
      ["GET", `/api/projects/prj_nonexistent`],
    ];
    for (const [method, path, body] of calls) {
      const res = await api(
        ctx.app,
        method,
        path,
        body === undefined
          ? { bearer: writeToken }
          : { bearer: writeToken, body },
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});
