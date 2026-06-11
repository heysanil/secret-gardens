import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { MAX_BULK_SECRETS } from "@safe/shared";
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

let ctx: TestApp;
let cookie: string;
let projectId: string;
let envId: string;

function base(path = ""): string {
  return `/api/projects/${projectId}/environments/${envId}/secrets${path}`;
}

beforeEach(async () => {
  ctx = await createTestApp(redis);
  const owner = await signUpUser(ctx.app, "owner");
  cookie = owner.cookie;
  const res = await api(ctx.app, "POST", "/api/projects", {
    cookie,
    body: { name: "Secrets Project" },
  });
  const project = (await res.json()) as {
    id: string;
    environments: Array<{ id: string }>;
  };
  projectId = project.id;
  envId = (project.environments[0] as { id: string }).id;
});

afterEach(() => {
  ctx.close();
});

async function versionHashLen(key: string): Promise<number> {
  return (await redis.send("HLEN", [
    `secretver:${projectId}:${envId}:${key}`,
  ])) as number;
}

describe("PUT bulk semantics", () => {
  test("repeat push is all unchanged with no version growth; prune deletes absent keys", async () => {
    const first = await api(ctx.app, "PUT", base(), {
      cookie,
      body: { secrets: { A: "1", B: "2", C: "3" } },
    });
    expect(await first.json()).toEqual({
      created: ["A", "B", "C"],
      updated: [],
      deleted: [],
      unchanged: 0,
    });

    const repeat = await api(ctx.app, "PUT", base(), {
      cookie,
      body: { secrets: { A: "1", B: "2", C: "3" } },
    });
    expect(await repeat.json()).toEqual({
      created: [],
      updated: [],
      deleted: [],
      unchanged: 3,
    });
    for (const key of ["A", "B", "C"]) {
      expect(await versionHashLen(key)).toBe(1);
    }

    const pruned = await api(ctx.app, "PUT", base(), {
      cookie,
      body: { secrets: { A: "1", B: "2!" }, prune: true },
    });
    expect(await pruned.json()).toEqual({
      created: [],
      updated: ["B"],
      deleted: ["C"],
      unchanged: 1,
    });

    // Prune deletion is audited like any other delete.
    const page = await ctx.audit.readAudit({ projectId }, { limit: 50 });
    const deleteEntry = page.entries.find((e) => e.action === "secret.delete");
    expect(deleteEntry?.key).toBe("C");
    expect(deleteEntry?.envId).toBe(envId);
  });

  test("empty secrets object with prune wipes the environment", async () => {
    await api(ctx.app, "PUT", base(), {
      cookie,
      body: { secrets: { A: "1", B: "2" } },
    });
    const wiped = await api(ctx.app, "PUT", base(), {
      cookie,
      body: { secrets: {}, prune: true },
    });
    expect(await wiped.json()).toEqual({
      created: [],
      updated: [],
      deleted: ["A", "B"],
      unchanged: 0,
    });
    const list = await api(ctx.app, "GET", base(), { cookie });
    expect(await list.json()).toEqual({ secrets: [] });
  });

  test("422 on invalid keys, oversize values, and oversized batches", async () => {
    const badKey = await api(ctx.app, "PUT", base(), {
      cookie,
      body: { secrets: { "BAD-KEY": "x", GOOD: "y" } },
    });
    expect(badKey.status).toBe(422);
    expect(await badKey.json()).toEqual({
      error: "invalid_secrets",
      keys: ["BAD-KEY"],
    });

    const oversize = await api(ctx.app, "PUT", base(), {
      cookie,
      body: { secrets: { BIG: "v".repeat(64 * 1024 + 1) } },
    });
    expect(oversize.status).toBe(422);
    expect(await oversize.json()).toEqual({
      error: "invalid_secrets",
      keys: ["BIG"],
    });

    const tooMany: Record<string, string> = {};
    for (let i = 0; i <= MAX_BULK_SECRETS; i++) {
      tooMany[`KEY_${i}`] = "v";
    }
    const res = await api(ctx.app, "PUT", base(), {
      cookie,
      body: { secrets: tooMany },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "too_many_secrets" });

    // Nothing was written by any of the rejected requests.
    const list = await api(ctx.app, "GET", base(), { cookie });
    expect(await list.json()).toEqual({ secrets: [] });
  });
});

describe("single-key routes", () => {
  test("PUT /:key validates key and value", async () => {
    const badKey = await api(ctx.app, "PUT", base("/9BAD"), {
      cookie,
      body: { value: "x" },
    });
    expect(badKey.status).toBe(422);
    expect(await badKey.json()).toEqual({ error: "invalid_key" });

    const badValue = await api(ctx.app, "PUT", base("/GOOD"), {
      cookie,
      body: { value: "v".repeat(64 * 1024 + 1) },
    });
    expect(badValue.status).toBe(422);
    expect(await badValue.json()).toEqual({ error: "invalid_value" });
  });

  test("DELETE /:key tombstones; absent key → 404", async () => {
    await api(ctx.app, "PUT", base("/DOOMED"), {
      cookie,
      body: { value: "x" },
    });
    const del = await api(ctx.app, "DELETE", base("/DOOMED"), { cookie });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true, version: 2 });

    const again = await api(ctx.app, "DELETE", base("/DOOMED"), { cookie });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "not_found" });
  });

  test("envId from another project → 404 on every secrets route", async () => {
    const other = await api(ctx.app, "POST", "/api/projects", {
      cookie,
      body: { name: "Other Project" },
    });
    const otherProject = (await other.json()) as {
      environments: Array<{ id: string }>;
    };
    const foreignEnvId = (otherProject.environments[0] as { id: string }).id;

    const foreign = (path = "") =>
      `/api/projects/${projectId}/environments/${foreignEnvId}/secrets${path}`;
    for (const [method, path, body] of [
      ["GET", foreign(), undefined],
      ["PUT", foreign(), { secrets: { A: "b" } }],
      ["PUT", foreign("/K"), { value: "v" }],
      ["DELETE", foreign("/K"), undefined],
      ["GET", foreign("/K/versions"), undefined],
      ["POST", foreign("/K/rollback"), { toVersion: 1 }],
    ] as const) {
      const res = await api(ctx.app, method, path, { cookie, body });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});

describe("GET /:key (single-secret read)", () => {
  test("metadata by default; include_value=true round-trips the value", async () => {
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "shh" } });

    const meta = await api(ctx.app, "GET", base("/K"), { cookie });
    expect(meta.status).toBe(200);
    expect(await meta.json()).toEqual({
      key: "K",
      version: 1,
      updatedAt: expect.any(Number),
      updatedBy: expect.any(String),
    });

    const values = await api(
      ctx.app,
      "GET",
      `${base("/K")}?include_value=true`,
      {
        cookie,
      },
    );
    expect(values.status).toBe(200);
    const body = (await values.json()) as { key: string; value?: string };
    expect(body.key).toBe("K");
    expect(body.value).toBe("shh");
  });

  test("unknown key → 404; tombstoned key → 404", async () => {
    const missing = await api(ctx.app, "GET", base("/NOPE"), { cookie });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    await api(ctx.app, "PUT", base("/GONE"), { cookie, body: { value: "x" } });
    await api(ctx.app, "DELETE", base("/GONE"), { cookie });
    const deleted = await api(ctx.app, "GET", base("/GONE"), { cookie });
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toEqual({ error: "not_found" });
  });

  test("GET /:key and GET /:key/versions resolve to their own routes", async () => {
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "one" } });
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "two" } });

    const single = await api(ctx.app, "GET", base("/K"), { cookie });
    expect(single.status).toBe(200);
    expect(((await single.json()) as { version: number }).version).toBe(2);

    const versionsRes = await api(ctx.app, "GET", base("/K/versions"), {
      cookie,
    });
    expect(versionsRes.status).toBe(200);
    const { versions } = (await versionsRes.json()) as {
      versions: Array<{ version: number }>;
    };
    expect(versions).toHaveLength(2);
  });

  test("include_value appends exactly one secrets.read entry; metadata none", async () => {
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "v" } });

    // Metadata-only read: no audit entry.
    await api(ctx.app, "GET", base("/K"), { cookie });
    const before = await ctx.audit.readAudit({ projectId }, { limit: 50 });
    expect(
      before.entries.filter((e) => e.action === "secrets.read"),
    ).toHaveLength(0);

    // Value read: exactly one entry with envId + key fields.
    await api(ctx.app, "GET", `${base("/K")}?include_value=true`, { cookie });
    const after = await ctx.audit.readAudit({ projectId }, { limit: 50 });
    const reads = after.entries.filter((e) => e.action === "secrets.read");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.envId).toBe(envId);
    expect(reads[0]?.key).toBe("K");
  });

  test("read-role member gets 200; non-member gets 404", async () => {
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "v" } });
    const reader = await createMemberUser(ctx.app, cookie, "reader");
    const stranger = await createMemberUser(ctx.app, cookie, "stranger");
    const added = await api(
      ctx.app,
      "POST",
      `/api/projects/${projectId}/members`,
      {
        cookie,
        body: { userId: reader.userId, role: "read" },
      },
    );
    expect(added.status).toBe(201);

    const ok = await api(ctx.app, "GET", `${base("/K")}?include_value=true`, {
      cookie: reader.cookie,
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { value?: string }).value).toBe("v");

    const denied = await api(ctx.app, "GET", base("/K"), {
      cookie: stranger.cookie,
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "not_found" });
  });

  test("env-scoped service token reads in scope; unlisted env → 403", async () => {
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "v" } });
    const detail = await api(ctx.app, "GET", `/api/projects/${projectId}`, {
      cookie,
    });
    const { environments } = (await detail.json()) as {
      environments: Array<{ id: string }>;
    };
    const otherEnvId = (
      environments.find((e) => e.id !== envId) as { id: string }
    ).id;
    const minted = await api(
      ctx.app,
      "POST",
      `/api/projects/${projectId}/tokens`,
      {
        cookie,
        body: { name: "scoped", scope: "read", environmentIds: [envId] },
      },
    );
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };

    const inScope = await api(
      ctx.app,
      "GET",
      `${base("/K")}?include_value=true`,
      { bearer: token },
    );
    expect(inScope.status).toBe(200);
    expect(((await inScope.json()) as { value?: string }).value).toBe("v");

    const outOfScope = await api(
      ctx.app,
      "GET",
      `/api/projects/${projectId}/environments/${otherEnvId}/secrets/K`,
      { bearer: token },
    );
    expect(outOfScope.status).toBe(403);
    expect(await outOfScope.json()).toEqual({ error: "forbidden" });
  });
});

describe("rollback", () => {
  test("multi-update then rollback to v1 restores the value with op metadata", async () => {
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "one" } });
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "two" } });
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "three" } });

    const res = await api(ctx.app, "POST", base("/K/rollback"), {
      cookie,
      body: { toVersion: 1 },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 4 });

    const values = await api(ctx.app, "GET", `${base()}?include_values=true`, {
      cookie,
    });
    const { secrets } = (await values.json()) as {
      secrets: Array<{ key: string; value: string }>;
    };
    expect(secrets[0]?.value).toBe("one");

    const versionsRes = await api(ctx.app, "GET", base("/K/versions"), {
      cookie,
    });
    const { versions } = (await versionsRes.json()) as {
      versions: Array<{ version: number; op: string; rollbackOf?: number }>;
    };
    expect(versions[0]).toMatchObject({
      version: 4,
      op: "rollback",
      rollbackOf: 1,
    });
  });

  test("unknown key/version → 404; tombstone target → 400", async () => {
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "x" } });
    await api(ctx.app, "DELETE", base("/K"), { cookie });

    const missingVersion = await api(ctx.app, "POST", base("/K/rollback"), {
      cookie,
      body: { toVersion: 42 },
    });
    expect(missingVersion.status).toBe(404);

    const missingKey = await api(ctx.app, "POST", base("/NOPE/rollback"), {
      cookie,
      body: { toVersion: 1 },
    });
    expect(missingKey.status).toBe(404);

    const tombstone = await api(ctx.app, "POST", base("/K/rollback"), {
      cookie,
      body: { toVersion: 2 },
    });
    expect(tombstone.status).toBe(400);
    expect(await tombstone.json()).toEqual({
      error: "cannot_rollback_to_delete",
    });
  });

  test("rollback to a pre-rotation version decrypts via the retired DEK", async () => {
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "early" } });
    await api(ctx.app, "POST", `/api/projects/${projectId}/rotate-dek`, {
      cookie,
    });
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "late" } });

    const res = await api(ctx.app, "POST", base("/K/rollback"), {
      cookie,
      body: { toVersion: 1 },
    });
    expect(res.status).toBe(200);

    // The new version preserved the old record's dekV 1.
    const raw = await redis.hget(`secrets:${projectId}:${envId}`, "K");
    expect((JSON.parse(raw as string) as { dekV: number }).dekV).toBe(1);

    const values = await api(ctx.app, "GET", `${base()}?include_values=true`, {
      cookie,
    });
    const { secrets } = (await values.json()) as {
      secrets: Array<{ value: string }>;
    };
    expect(secrets[0]?.value).toBe("early");
  });
});

describe("ciphertext transplant defense", () => {
  test("a current record copied onto another key → 500 decrypt_failed, never a wrong plaintext", async () => {
    await api(ctx.app, "PUT", base(), {
      cookie,
      body: { secrets: { SOURCE: "the-secret", TARGET: "innocent" } },
    });

    // Raw HSET-copy SOURCE's stored JSON onto TARGET's field.
    const source = await redis.hget(`secrets:${projectId}:${envId}`, "SOURCE");
    await redis.send("HSET", [
      `secrets:${projectId}:${envId}`,
      "TARGET",
      source as string,
    ]);

    const res = await api(ctx.app, "GET", `${base()}?include_values=true`, {
      cookie,
    });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "decrypt_failed" });
    expect(body).not.toContain("the-secret");
  });
});

describe("audit on reads", () => {
  test("include_values appends exactly one secrets.read entry per request", async () => {
    await api(ctx.app, "PUT", base(), {
      cookie,
      body: { secrets: { A: "1", B: "2" } },
    });
    const before = await ctx.audit.readAudit({ projectId }, { limit: 50 });
    const readsBefore = before.entries.filter(
      (e) => e.action === "secrets.read",
    ).length;

    // Metadata-only read: no audit entry.
    await api(ctx.app, "GET", base(), { cookie });
    // Values read: exactly one entry.
    await api(ctx.app, "GET", `${base()}?include_values=true`, { cookie });

    const after = await ctx.audit.readAudit({ projectId }, { limit: 50 });
    const reads = after.entries.filter((e) => e.action === "secrets.read");
    expect(reads.length).toBe(readsBefore + 1);
    expect(reads[0]?.envId).toBe(envId);
    expect(reads[0]?.keys).toBe("2");
  });

  test("versions include_values audits the decrypted version count", async () => {
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "one" } });
    await api(ctx.app, "PUT", base("/K"), { cookie, body: { value: "two" } });
    await api(ctx.app, "DELETE", base("/K"), { cookie }); // v3 tombstone

    // Metadata-only versions read: no audit entry.
    await api(ctx.app, "GET", base("/K/versions"), { cookie });
    const res = await api(
      ctx.app,
      "GET",
      `${base("/K/versions")}?include_values=true`,
      { cookie },
    );
    expect(res.status).toBe(200);

    const page = await ctx.audit.readAudit({ projectId }, { limit: 50 });
    const reads = page.entries.filter(
      (e) => e.action === "secrets.read" && e.key === "K",
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]?.envId).toBe(envId);
    // Two versions decrypted; the tombstone carries no value.
    expect(reads[0]?.versions).toBe("2");
  });
});
