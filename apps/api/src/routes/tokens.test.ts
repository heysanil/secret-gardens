import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
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

const SERVICE_TOKEN_RE = /^sg_st_[A-Za-z0-9_-]{43}$/;
const DAY_MS = 86_400_000;

let ctx: TestApp;
let owner: { cookie: string; userId: string };
let projectId: string;
let envIds: string[];

function tokensPath(path = ""): string {
  return `/api/projects/${projectId}/tokens${path}`;
}

interface CreatedToken {
  id: string;
  name: string;
  token: string;
  tokenPrefix: string;
  scope: string;
  environmentIds: string[] | null;
  expiresAt: number | null;
}

async function createServiceToken(
  body: Record<string, unknown>,
): Promise<Response> {
  return api(ctx.app, "POST", tokensPath(), { cookie: owner.cookie, body });
}

beforeEach(async () => {
  ctx = await createTestApp(redis);
  owner = await signUpUser(ctx.app, "owner");
  const res = await api(ctx.app, "POST", "/api/projects", {
    cookie: owner.cookie,
    body: { name: "Token Project" },
  });
  const project = (await res.json()) as {
    id: string;
    environments: Array<{ id: string }>;
  };
  projectId = project.id;
  envIds = project.environments.map((e) => e.id);
});

afterEach(() => {
  ctx.close();
});

describe("POST /api/projects/:projectId/tokens", () => {
  test("creates a token: plaintext exactly once, sha256 row, prefix, audit entry", async () => {
    const res = await createServiceToken({ name: "ci deploy", scope: "read" });
    expect(res.status).toBe(201);
    const text = await res.text();
    const body = JSON.parse(text) as CreatedToken;
    expect(body.token).toMatch(SERVICE_TOKEN_RE);
    expect(body.tokenPrefix).toBe(body.token.slice(0, 12));
    expect(body.name).toBe("ci deploy");
    expect(body.scope).toBe("read");
    expect(body.environmentIds).toBeNull();
    expect(body.expiresAt).toBeNull();
    // The plaintext appears exactly once in the response payload.
    expect(text.split(body.token).length - 1).toBe(1);

    // Only the sha256 hash is stored, with NULL environment_ids.
    const row = ctx.db
      .query<
        {
          token_hash: string;
          token_prefix: string;
          scope: string;
          environment_ids: string | null;
          expires_at: number | null;
          created_by: string;
        },
        [string]
      >(
        `SELECT token_hash, token_prefix, scope, environment_ids, expires_at, created_by
         FROM service_tokens WHERE id = ?`,
      )
      .get(body.id);
    expect(row?.token_hash).toBe(
      createHash("sha256").update(body.token).digest("hex"),
    );
    expect(row?.token_prefix).toBe(body.tokenPrefix);
    expect(row?.scope).toBe("read");
    expect(row?.environment_ids).toBeNull();
    expect(row?.expires_at).toBeNull();
    expect(row?.created_by).toBe(owner.userId);

    // token.create lands on the PROJECT audit stream.
    const page = await ctx.audit.readAudit({ projectId }, { limit: 50 });
    const entry = page.entries.find(
      (e) => e.action === "token.create" && e.tokenId === body.id,
    );
    expect(entry).toBeDefined();
    expect(entry?.actorType).toBe("user");
    expect(entry?.actorId).toBe(owner.userId);
    expect(entry?.tokenType).toBe("service");
    expect(entry?.name).toBe("ci deploy");
    expect(entry?.scope).toBe("read");
  });

  test("stores environmentIds as JSON and computes expiresAt", async () => {
    const scopedEnvs = [envIds[0] as string, envIds[1] as string];
    const before = Date.now();
    const res = await createServiceToken({
      name: "scoped",
      scope: "read_write",
      environmentIds: scopedEnvs,
      expiresInDays: 30,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreatedToken;
    expect(body.environmentIds).toEqual(scopedEnvs);
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);

    const row = ctx.db
      .query<{ environment_ids: string | null }, [string]>(
        "SELECT environment_ids FROM service_tokens WHERE id = ?",
      )
      .get(body.id);
    expect(JSON.parse(row?.environment_ids ?? "")).toEqual(scopedEnvs);
  });

  test("explicit null environmentIds means all environments", async () => {
    const res = await createServiceToken({
      name: "all envs",
      scope: "read",
      environmentIds: null,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreatedToken;
    expect(body.environmentIds).toBeNull();
  });

  for (const [label, body] of [
    ["a bad scope", { name: "t", scope: "admin" }],
    ["a missing scope", { name: "t" }],
    [
      "an empty environmentIds array",
      { name: "t", scope: "read", environmentIds: [] },
    ],
    ["zero expiresInDays", { name: "t", scope: "read", expiresInDays: 0 }],
    ["negative expiresInDays", { name: "t", scope: "read", expiresInDays: -5 }],
    [
      "expiresInDays above 3650",
      { name: "t", scope: "read", expiresInDays: 3651 },
    ],
    [
      "fractional expiresInDays",
      { name: "t", scope: "read", expiresInDays: 1.5 },
    ],
    ["an empty name", { name: "", scope: "read" }],
    ["a name above 100 chars", { name: "x".repeat(101), scope: "read" }],
  ] as const) {
    test(`rejects ${label} with 422`, async () => {
      const res = await createServiceToken(body);
      expect(res.status).toBe(422);
    });
  }

  test("rejects environment ids from another project, listing offenders", async () => {
    const otherRes = await api(ctx.app, "POST", "/api/projects", {
      cookie: owner.cookie,
      body: { name: "Other Project" },
    });
    const other = (await otherRes.json()) as {
      environments: Array<{ id: string }>;
    };
    const foreignEnv = (other.environments[0] as { id: string }).id;

    const res = await createServiceToken({
      name: "bad envs",
      scope: "read",
      environmentIds: [envIds[0] as string, foreignEnv, "env_nonexistent"],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "invalid_environment_ids",
      environmentIds: [foreignEnv, "env_nonexistent"],
    });
    // Nothing was stored.
    const count = ctx.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM service_tokens WHERE project_id = ?",
      )
      .get(projectId);
    expect(count?.n).toBe(0);
  });

  test("requires project admin (write member → 403)", async () => {
    const writer = await createMemberUser(ctx.app, owner.cookie, "writer");
    await api(ctx.app, "POST", `/api/projects/${projectId}/members`, {
      cookie: owner.cookie,
      body: { userId: writer.userId, role: "write" },
    });
    const res = await api(ctx.app, "POST", tokensPath(), {
      cookie: writer.cookie,
      body: { name: "nope", scope: "read" },
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/projects/:projectId/tokens", () => {
  test("lists metadata but never hashes or plaintext", async () => {
    const created = (await (
      await createServiceToken({
        name: "listed",
        scope: "read_write",
        environmentIds: [envIds[0] as string],
      })
    ).json()) as CreatedToken;

    const res = await api(ctx.app, "GET", tokensPath(), {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const list = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: created.id,
      name: "listed",
      tokenPrefix: created.token.slice(0, 12),
      scope: "read_write",
      environmentIds: [envIds[0]],
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      createdBy: owner.userId,
      createdAt: expect.any(Number),
    });
    expect(text).not.toContain(created.token);
    expect(text).not.toContain(
      createHash("sha256").update(created.token).digest("hex"),
    );
  });
});

describe("DELETE /api/projects/:projectId/tokens/:tokenId", () => {
  test("revokes: token stops working, idempotent, audited once", async () => {
    const created = (await (
      await createServiceToken({ name: "to revoke", scope: "read" })
    ).json()) as CreatedToken;
    const secretsPath = `/api/projects/${projectId}/environments/${envIds[0]}/secrets`;

    // Works before revocation.
    const before = await api(ctx.app, "GET", secretsPath, {
      bearer: created.token,
    });
    expect(before.status).toBe(200);

    const first = await api(ctx.app, "DELETE", tokensPath(`/${created.id}`), {
      cookie: owner.cookie,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ revoked: true });
    const row = ctx.db
      .query<{ revoked_at: number | null }, [string]>(
        "SELECT revoked_at FROM service_tokens WHERE id = ?",
      )
      .get(created.id);
    expect(row?.revoked_at).not.toBeNull();

    // 401 on use after revocation.
    const after = await api(ctx.app, "GET", secretsPath, {
      bearer: created.token,
    });
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "invalid_token" });

    // Idempotent second delete.
    const second = await api(ctx.app, "DELETE", tokensPath(`/${created.id}`), {
      cookie: owner.cookie,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ revoked: true });

    // token.revoke audited exactly once on the project stream.
    const page = await ctx.audit.readAudit({ projectId }, { limit: 50 });
    const entries = page.entries.filter(
      (e) => e.action === "token.revoke" && e.tokenId === created.id,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tokenType).toBe("service");
    expect(entries[0]?.actorId).toBe(owner.userId);
  });

  test("a token belonging to another project → 404", async () => {
    const created = (await (
      await createServiceToken({ name: "p1 token", scope: "read" })
    ).json()) as CreatedToken;
    const otherRes = await api(ctx.app, "POST", "/api/projects", {
      cookie: owner.cookie,
      body: { name: "Second Project" },
    });
    const other = (await otherRes.json()) as { id: string };

    const res = await api(
      ctx.app,
      "DELETE",
      `/api/projects/${other.id}/tokens/${created.id}`,
      { cookie: owner.cookie },
    );
    expect(res.status).toBe(404);
    // The token is untouched.
    const row = ctx.db
      .query<{ revoked_at: number | null }, [string]>(
        "SELECT revoked_at FROM service_tokens WHERE id = ?",
      )
      .get(created.id);
    expect(row?.revoked_at).toBeNull();
  });

  test("an unknown token id → 404", async () => {
    const res = await api(ctx.app, "DELETE", tokensPath("/st_does_not_exist"), {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(404);
  });
});

describe("service token expiry", () => {
  test("an expired token gets 401 on use", async () => {
    const created = (await (
      await createServiceToken({
        name: "expiring",
        scope: "read",
        expiresInDays: 1,
      })
    ).json()) as CreatedToken;
    ctx.db.run("UPDATE service_tokens SET expires_at = ? WHERE id = ?", [
      Date.now() - 1000,
      created.id,
    ]);
    const res = await api(
      ctx.app,
      "GET",
      `/api/projects/${projectId}/environments/${envIds[0]}/secrets`,
      { bearer: created.token },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  test("use sets last_used_at, throttled within the 60s window", async () => {
    const created = (await (
      await createServiceToken({ name: "lu", scope: "read" })
    ).json()) as CreatedToken;
    const secretsPath = `/api/projects/${projectId}/environments/${envIds[0]}/secrets`;
    const lastUsed = () =>
      ctx.db
        .query<{ last_used_at: number | null }, [string]>(
          "SELECT last_used_at FROM service_tokens WHERE id = ?",
        )
        .get(created.id)?.last_used_at ?? null;

    expect(lastUsed()).toBeNull();
    await api(ctx.app, "GET", secretsPath, { bearer: created.token });
    const first = lastUsed();
    expect(first).not.toBeNull();

    await api(ctx.app, "GET", secretsPath, { bearer: created.token });
    expect(lastUsed()).toBe(first);

    ctx.db.run("UPDATE service_tokens SET last_used_at = ? WHERE id = ?", [
      Date.now() - 61_000,
      created.id,
    ]);
    await api(ctx.app, "GET", secretsPath, { bearer: created.token });
    expect(lastUsed()).toBeGreaterThan(Date.now() - 5_000);
  });
});
