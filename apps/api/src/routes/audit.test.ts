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

let ctx: TestApp;
let owner: { cookie: string; userId: string };
let projectId: string;
let envA: string;
let envB: string;

interface AuditEntryJson {
  id: string;
  ts: number;
  action: string;
  actorType: string;
  actorId: string;
  [field: string]: string | number;
}

interface AuditPageJson {
  entries: AuditEntryJson[];
  nextCursor: string | null;
}

function auditPath(qs = ""): string {
  return `/api/projects/${projectId}/audit${qs}`;
}

/** Appends n secret.update entries directly to the project stream. */
async function seedEntries(
  n: number,
  fields: Record<string, string> = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      await ctx.audit.appendAudit(
        { projectId },
        {
          action: "secret.update",
          actorType: "user",
          actorId: `usr_seed_${i}`,
          fields,
        },
      ),
    );
  }
  return ids;
}

beforeEach(async () => {
  ctx = await createTestApp(redis);
  owner = await signUpUser(ctx.app, "owner");
  const res = await api(ctx.app, "POST", "/api/projects", {
    cookie: owner.cookie,
    body: { name: "Audit Project" },
  });
  const project = (await res.json()) as {
    id: string;
    environments: Array<{ id: string }>;
  };
  projectId = project.id;
  envA = (project.environments[0] as { id: string }).id;
  envB = (project.environments[1] as { id: string }).id;
});

afterEach(() => {
  ctx.close();
});

describe("GET /api/projects/:projectId/audit", () => {
  test("returns newest-first entries with the readAudit shape", async () => {
    await api(
      ctx.app,
      "PUT",
      `/api/projects/${projectId}/environments/${envA}/secrets/KEY`,
      {
        cookie: owner.cookie,
        body: { value: "v1" },
      },
    );

    const res = await api(ctx.app, "GET", auditPath(), {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditPageJson;
    // project.create (from setup) + secret.create.
    expect(body.entries.length).toBeGreaterThanOrEqual(2);
    expect(body.nextCursor).toBeNull();
    const first = body.entries[0] as AuditEntryJson;
    expect(first.action).toBe("secret.create");
    expect(first.actorType).toBe("user");
    expect(first.actorId).toBe(owner.userId);
    expect(first.envId).toBe(envA);
    expect(first.key).toBe("KEY");
    expect(first.id).toMatch(/^\d+-\d+$/);
    expect(first.ts).toBeGreaterThan(0);
  });

  test("default limit is 50", async () => {
    await seedEntries(60);
    const res = await api(ctx.app, "GET", auditPath(), {
      cookie: owner.cookie,
    });
    const body = (await res.json()) as AuditPageJson;
    expect(body.entries).toHaveLength(50);
    expect(body.nextCursor).not.toBeNull();
  });

  for (const bad of ["101", "0", "-5", "1.5", "abc"]) {
    test(`limit=${bad} → 422 invalid_limit`, async () => {
      const res = await api(ctx.app, "GET", auditPath(`?limit=${bad}`), {
        cookie: owner.cookie,
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "invalid_limit" });
    });
  }

  test("limit=100 is accepted", async () => {
    const res = await api(ctx.app, "GET", auditPath("?limit=100"), {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
  });

  test("cursor pagination walks the stream fully, exactly once", async () => {
    const seeded = await seedEntries(12);

    const seen: string[] = [];
    let cursor: string | null = null;
    let rounds = 0;
    do {
      const qs: string =
        cursor === null ? "?limit=5" : `?limit=5&cursor=${cursor}`;
      const res = await api(ctx.app, "GET", auditPath(qs), {
        cookie: owner.cookie,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as AuditPageJson;
      seen.push(...body.entries.map((e) => e.id));
      cursor = body.nextCursor;
      rounds++;
      expect(rounds).toBeLessThanOrEqual(5);
    } while (cursor !== null);

    // 12 seeded + 1 project.create from setup, no duplicates, newest first.
    expect(seen).toHaveLength(13);
    expect(new Set(seen).size).toBe(13);
    expect(seen.slice(0, 12)).toEqual([...seeded].reverse());
  });

  for (const bad of ["garbage", "(123-0", "123", "12-3-4", "1-0 extra"]) {
    test(`malformed cursor "${bad}" → 422 invalid_cursor`, async () => {
      const res = await api(
        ctx.app,
        "GET",
        auditPath(`?cursor=${encodeURIComponent(bad)}`),
        { cookie: owner.cookie },
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "invalid_cursor" });
    });
  }

  test("a well-formed cursor older than every entry returns an empty page", async () => {
    await seedEntries(3);
    const res = await api(ctx.app, "GET", auditPath("?cursor=1-0"), {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [], nextCursor: null });
  });

  test("action filter returns only matching entries; unknown action → 422", async () => {
    await seedEntries(3);
    const filtered = await api(
      ctx.app,
      "GET",
      auditPath("?action=secret.update"),
      { cookie: owner.cookie },
    );
    const body = (await filtered.json()) as AuditPageJson;
    expect(body.entries).toHaveLength(3);
    for (const entry of body.entries) {
      expect(entry.action).toBe("secret.update");
    }

    const unknown = await api(
      ctx.app,
      "GET",
      auditPath("?action=secret.explode"),
      { cookie: owner.cookie },
    );
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toEqual({ error: "invalid_action" });
  });

  test("envId filter returns only that environment's entries", async () => {
    await seedEntries(2, { envId: envA });
    await seedEntries(3, { envId: envB });
    const res = await api(ctx.app, "GET", auditPath(`?envId=${envA}`), {
      cookie: owner.cookie,
    });
    const body = (await res.json()) as AuditPageJson;
    expect(body.entries).toHaveLength(2);
    for (const entry of body.entries) {
      expect(entry.envId).toBe(envA);
    }
  });

  test("a read-role member can read the audit log", async () => {
    const reader = await createMemberUser(ctx.app, owner.cookie, "reader");
    await api(ctx.app, "POST", `/api/projects/${projectId}/members`, {
      cookie: owner.cookie,
      body: { userId: reader.userId, role: "read" },
    });
    const res = await api(ctx.app, "GET", auditPath(), {
      cookie: reader.cookie,
    });
    expect(res.status).toBe(200);
  });

  test("a non-member gets 404 (no existence leak)", async () => {
    const stranger = await createMemberUser(ctx.app, owner.cookie, "stranger");
    const res = await api(ctx.app, "GET", auditPath(), {
      cookie: stranger.cookie,
    });
    expect(res.status).toBe(404);
  });

  test("a service token of the same project gets 403", async () => {
    const minted = await api(
      ctx.app,
      "POST",
      `/api/projects/${projectId}/tokens`,
      {
        cookie: owner.cookie,
        body: { name: "ci", scope: "read_write" },
      },
    );
    const { token } = (await minted.json()) as { token: string };
    const res = await api(ctx.app, "GET", auditPath(), { bearer: token });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("no credentials → 401", async () => {
    const res = await api(ctx.app, "GET", auditPath());
    expect(res.status).toBe(401);
  });
});
