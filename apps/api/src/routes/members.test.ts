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
let owner: { cookie: string; userId: string; email: string };
let other: { cookie: string; userId: string; email: string };
let projectId: string;

function membersPath(path = ""): string {
  return `/api/projects/${projectId}/members${path}`;
}

beforeEach(async () => {
  ctx = await createTestApp(redis);
  owner = await signUpUser(ctx.app, "owner");
  other = await createMemberUser(ctx.app, owner.cookie, "other");
  const res = await api(ctx.app, "POST", "/api/projects", {
    cookie: owner.cookie,
    body: { name: "Members Project" },
  });
  projectId = ((await res.json()) as { id: string }).id;
});

afterEach(() => {
  ctx.close();
});

describe("GET /members", () => {
  test("lists members with user details from the better-auth table", async () => {
    const res = await api(ctx.app, "GET", membersPath(), {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const members = (await res.json()) as Array<{
      userId: string;
      name: string;
      email: string;
      role: string;
      createdAt: number;
    }>;
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe(owner.userId);
    expect(members[0]?.email).toBe(owner.email);
    expect(members[0]?.role).toBe("admin");
    expect(members[0]?.createdAt).toBeGreaterThan(0);
  });
});

describe("POST /members", () => {
  test("adds a member and audits; unknown user → 404; duplicate → 409", async () => {
    const res = await api(ctx.app, "POST", membersPath(), {
      cookie: owner.cookie,
      body: { userId: other.userId, role: "read" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      userId: other.userId,
      email: other.email,
      role: "read",
    });

    const page = await ctx.audit.readAudit({ projectId }, { limit: 10 });
    const entry = page.entries.find((e) => e.action === "member.add");
    expect(entry?.userId).toBe(other.userId);
    expect(entry?.role).toBe("read");

    const unknown = await api(ctx.app, "POST", membersPath(), {
      cookie: owner.cookie,
      body: { userId: "usr_ghost", role: "read" },
    });
    expect(unknown.status).toBe(404);

    const dup = await api(ctx.app, "POST", membersPath(), {
      cookie: owner.cookie,
      body: { userId: other.userId, role: "write" },
    });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "already_member" });
  });
});

describe("last-admin protection", () => {
  test("demoting or removing the only admin → 409 last_admin", async () => {
    const demote = await api(
      ctx.app,
      "PATCH",
      membersPath(`/${owner.userId}`),
      {
        cookie: owner.cookie,
        body: { role: "read" },
      },
    );
    expect(demote.status).toBe(409);
    expect(await demote.json()).toEqual({ error: "last_admin" });

    const remove = await api(
      ctx.app,
      "DELETE",
      membersPath(`/${owner.userId}`),
      { cookie: owner.cookie },
    );
    expect(remove.status).toBe(409);
    expect(await remove.json()).toEqual({ error: "last_admin" });
  });

  test("after adding a second admin, the first can be demoted", async () => {
    await api(ctx.app, "POST", membersPath(), {
      cookie: owner.cookie,
      body: { userId: other.userId, role: "admin" },
    });
    const demote = await api(
      ctx.app,
      "PATCH",
      membersPath(`/${owner.userId}`),
      {
        cookie: owner.cookie,
        body: { role: "write" },
      },
    );
    expect(demote.status).toBe(200);
    expect(await demote.json()).toEqual({
      userId: owner.userId,
      role: "write",
    });

    const page = await ctx.audit.readAudit({ projectId }, { limit: 10 });
    expect(page.entries.some((e) => e.action === "member.update")).toBe(true);
  });

  test("removing a non-admin member works and audits member.remove", async () => {
    await api(ctx.app, "POST", membersPath(), {
      cookie: owner.cookie,
      body: { userId: other.userId, role: "write" },
    });
    const remove = await api(
      ctx.app,
      "DELETE",
      membersPath(`/${other.userId}`),
      { cookie: owner.cookie },
    );
    expect(remove.status).toBe(200);
    expect(await remove.json()).toEqual({ removed: true });

    const page = await ctx.audit.readAudit({ projectId }, { limit: 10 });
    const entry = page.entries.find((e) => e.action === "member.remove");
    expect(entry?.userId).toBe(other.userId);

    const members = await api(ctx.app, "GET", membersPath(), {
      cookie: owner.cookie,
    });
    expect((await members.json()) as unknown[]).toHaveLength(1);
  });

  test("PATCH/DELETE on a non-member → 404", async () => {
    const patch = await api(ctx.app, "PATCH", membersPath(`/${other.userId}`), {
      cookie: owner.cookie,
      body: { role: "read" },
    });
    expect(patch.status).toBe(404);
    const del = await api(ctx.app, "DELETE", membersPath(`/${other.userId}`), {
      cookie: owner.cookie,
    });
    expect(del.status).toBe(404);
  });
});
