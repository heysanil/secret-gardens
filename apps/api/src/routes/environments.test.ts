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
import { createRedis, type RedisLike } from "../redis/client";

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
let devEnvId: string;
let stagingEnvId: string;

beforeEach(async () => {
  ctx = await createTestApp(redis);
  const owner = await signUpUser(ctx.app, "owner");
  cookie = owner.cookie;
  const res = await api(ctx.app, "POST", "/api/projects", {
    cookie,
    body: { name: "Env Project" },
  });
  const project = (await res.json()) as {
    id: string;
    environments: Array<{ id: string; slug: string }>;
  };
  projectId = project.id;
  devEnvId = (
    project.environments.find((e) => e.slug === "dev") as { id: string }
  ).id;
  stagingEnvId = (
    project.environments.find((e) => e.slug === "staging") as { id: string }
  ).id;
});

afterEach(() => {
  ctx.close();
});

async function scanCount(client: RedisLike, pattern: string): Promise<number> {
  let cursor = "0";
  let count = 0;
  do {
    const reply = (await client.send("SCAN", [
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      "1000",
    ])) as [string, string[]];
    cursor = reply[0];
    count += reply[1].length;
  } while (cursor !== "0");
  return count;
}

function envsPath(path = ""): string {
  return `/api/projects/${projectId}/environments${path}`;
}

function secretsPath(envId: string): string {
  return `/api/projects/${projectId}/environments/${envId}/secrets`;
}

describe("POST /environments", () => {
  test("creates with next position and audits env.create", async () => {
    const res = await api(ctx.app, "POST", envsPath(), {
      cookie,
      body: { name: "QA", slug: "qa" },
    });
    expect(res.status).toBe(201);
    const env = (await res.json()) as {
      id: string;
      name: string;
      slug: string;
      position: number;
    };
    expect(env.name).toBe("QA");
    expect(env.slug).toBe("qa");
    expect(env.position).toBe(3); // after dev/staging/prod

    const page = await ctx.audit.readAudit({ projectId }, { limit: 10 });
    const entry = page.entries.find((e) => e.action === "env.create");
    expect(entry?.envId).toBe(env.id);
    expect(entry?.slug).toBe("qa");
  });

  test("duplicate slug in the same project → 409; invalid slug → 422", async () => {
    const dup = await api(ctx.app, "POST", envsPath(), {
      cookie,
      body: { name: "Development 2", slug: "dev" },
    });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "duplicate_slug" });

    const bad = await api(ctx.app, "POST", envsPath(), {
      cookie,
      body: { name: "Bad", slug: "Bad_Slug" },
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: "invalid_slug" });

    // The same slug in ANOTHER project is fine.
    const other = await api(ctx.app, "POST", "/api/projects", {
      cookie,
      body: { name: "Other" },
    });
    const otherProject = (await other.json()) as { id: string };
    const ok = await api(
      ctx.app,
      "POST",
      `/api/projects/${otherProject.id}/environments`,
      { cookie, body: { name: "Dev Two", slug: "dev-two" } },
    );
    expect(ok.status).toBe(201);
  });
});

describe("PATCH /environments/:envId", () => {
  test("renames without breaking decryption (AAD is id-based)", async () => {
    await api(ctx.app, "PUT", `${secretsPath(devEnvId)}/K`, {
      cookie,
      body: { value: "survives-rename" },
    });

    const res = await api(ctx.app, "PATCH", envsPath(`/${devEnvId}`), {
      cookie,
      body: { name: "Development Renamed", position: 9 },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: devEnvId,
      name: "Development Renamed",
      slug: "dev", // slug immutable
      position: 9,
    });

    const values = await api(
      ctx.app,
      "GET",
      `${secretsPath(devEnvId)}?include_values=true`,
      { cookie },
    );
    expect(values.status).toBe(200);
    const { secrets } = (await values.json()) as {
      secrets: Array<{ value: string }>;
    };
    expect(secrets[0]?.value).toBe("survives-rename");

    const page = await ctx.audit.readAudit({ projectId }, { limit: 10 });
    expect(page.entries.some((e) => e.action === "env.update")).toBe(true);
  });

  test("envId from another project → 404", async () => {
    const other = await api(ctx.app, "POST", "/api/projects", {
      cookie,
      body: { name: "Foreign" },
    });
    const otherProject = (await other.json()) as {
      environments: Array<{ id: string }>;
    };
    const foreignEnvId = (otherProject.environments[0] as { id: string }).id;
    const res = await api(ctx.app, "PATCH", envsPath(`/${foreignEnvId}`), {
      cookie,
      body: { name: "Nope" },
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /environments/:envId", () => {
  test("removes the row and all redis data; sibling envs untouched", async () => {
    await api(ctx.app, "PUT", `${secretsPath(devEnvId)}/A`, {
      cookie,
      body: { value: "a" },
    });
    await api(ctx.app, "PUT", `${secretsPath(stagingEnvId)}/B`, {
      cookie,
      body: { value: "b" },
    });

    const res = await api(ctx.app, "DELETE", envsPath(`/${devEnvId}`), {
      cookie,
    });
    expect(res.status).toBe(200);

    expect(
      ctx.db.query("SELECT id FROM environments WHERE id = ?").get(devEnvId),
    ).toBeNull();
    expect(await scanCount(redis, `secrets:${projectId}:${devEnvId}`)).toBe(0);
    expect(await scanCount(redis, `secretver:${projectId}:${devEnvId}:*`)).toBe(
      0,
    );
    expect(
      await scanCount(redis, `secretvctr:${projectId}:${devEnvId}:*`),
    ).toBe(0);

    // Sibling env data untouched.
    const staging = await api(
      ctx.app,
      "GET",
      `${secretsPath(stagingEnvId)}?include_values=true`,
      { cookie },
    );
    const { secrets } = (await staging.json()) as {
      secrets: Array<{ key: string; value: string }>;
    };
    expect(secrets).toEqual([
      expect.objectContaining({ key: "B", value: "b" }),
    ]);

    const page = await ctx.audit.readAudit({ projectId }, { limit: 10 });
    const entry = page.entries.find((e) => e.action === "env.delete");
    expect(entry?.envId).toBe(devEnvId);
  });
});
