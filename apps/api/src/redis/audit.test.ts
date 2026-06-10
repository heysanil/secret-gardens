import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TEST_REDIS_URL } from "../../test/testRedis";
import { newId } from "../db/ids";
import {
  type AuditEntry,
  type AuditScope,
  createAuditLog,
  normalizeStreamEntries,
} from "./audit";
import { createRedis } from "./client";

const redis = createRedis(TEST_REDIS_URL);

beforeAll(async () => {
  await redis.connect();
});

afterAll(() => {
  redis.close();
});

describe("normalizeStreamEntries", () => {
  test("handles array-shaped replies (entry = [id, [f1, v1, ...]])", () => {
    const raw = [
      ["2-0", ["action", "secret.update", "actorId", "usr_b"]],
      ["1-0", ["action", "secret.create", "actorId", "usr_a"]],
    ];
    expect(normalizeStreamEntries(raw)).toEqual([
      { id: "2-0", fields: { action: "secret.update", actorId: "usr_b" } },
      { id: "1-0", fields: { action: "secret.create", actorId: "usr_a" } },
    ]);
  });

  test("handles map-shaped replies (RESP3 maps)", () => {
    const raw = new Map<string, unknown>([
      ["2-0", new Map([["action", "a.b"]])],
      ["1-0", { action: "c.d" }],
    ]);
    expect(normalizeStreamEntries(raw)).toEqual([
      { id: "2-0", fields: { action: "a.b" } },
      { id: "1-0", fields: { action: "c.d" } },
    ]);
  });

  test("handles entries whose field payload is a plain object", () => {
    const raw = [["3-0", { action: "x.y", envId: "env_1" }]];
    expect(normalizeStreamEntries(raw)).toEqual([
      { id: "3-0", fields: { action: "x.y", envId: "env_1" } },
    ]);
  });

  test("returns [] for null, undefined, and empty replies", () => {
    expect(normalizeStreamEntries(null)).toEqual([]);
    expect(normalizeStreamEntries(undefined)).toEqual([]);
    expect(normalizeStreamEntries([])).toEqual([]);
  });
});

describe("audit log", () => {
  const audit = createAuditLog(redis);

  test("append → read round-trip preserves all fields", async () => {
    const scope: AuditScope = { projectId: newId("prj") };
    const before = Date.now();
    const id = await audit.appendAudit(scope, {
      action: "secret.create",
      actorType: "user",
      actorId: "usr_rt",
      fields: { envId: "env_rt", secretKey: "API_KEY" },
    });
    expect(id).toMatch(/^\d+-\d+$/);

    const page = await audit.readAudit(scope, {});
    expect(page.entries).toHaveLength(1);
    const entry = page.entries[0] as AuditEntry;
    expect(entry.id).toBe(id);
    expect(entry.action).toBe("secret.create");
    expect(entry.actorType).toBe("user");
    expect(entry.actorId).toBe("usr_rt");
    expect(entry.envId).toBe("env_rt");
    expect(entry.secretKey).toBe("API_KEY");
    expect(entry.ts).toBeGreaterThanOrEqual(before);
    expect(entry.ts).toBeLessThanOrEqual(Date.now());
    expect(page.nextCursor).toBeNull();
  });

  test("read returns newest first", async () => {
    const scope: AuditScope = { projectId: newId("prj") };
    const ids: string[] = [];
    for (const action of [
      "secret.create",
      "secret.update",
      "secret.delete",
    ] as const) {
      ids.push(
        await audit.appendAudit(scope, {
          action,
          actorType: "user",
          actorId: "usr_o",
          fields: {},
        }),
      );
    }
    const page = await audit.readAudit(scope, {});
    expect(page.entries.map((e) => e.id)).toEqual([...ids].reverse());
  });

  test("cursor pagination walks the full stream exactly once (limit 2 over 7)", async () => {
    const scope: AuditScope = { projectId: newId("prj") };
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(
        await audit.appendAudit(scope, {
          action: "secret.update",
          actorType: "user",
          actorId: `usr_${i}`,
          fields: {},
        }),
      );
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let rounds = 0;
    do {
      const page = await audit.readAudit(scope, {
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
      rounds++;
      expect(rounds).toBeLessThanOrEqual(5);
    } while (cursor !== null);

    expect(seen).toEqual([...ids].reverse());
    expect(new Set(seen).size).toBe(7);
  });

  test("action filter returns only matching entries", async () => {
    const scope: AuditScope = { projectId: newId("prj") };
    await audit.appendAudit(scope, {
      action: "secret.create",
      actorType: "user",
      actorId: "usr_f",
      fields: {},
    });
    await audit.appendAudit(scope, {
      action: "secrets.read",
      actorType: "service_token",
      actorId: "st_f",
      fields: {},
    });
    await audit.appendAudit(scope, {
      action: "secret.create",
      actorType: "user",
      actorId: "usr_f2",
      fields: {},
    });

    const page = await audit.readAudit(scope, { action: "secret.create" });
    expect(page.entries).toHaveLength(2);
    for (const entry of page.entries) {
      expect(entry.action).toBe("secret.create");
    }
  });

  test("envId filter returns only matching entries", async () => {
    const scope: AuditScope = { projectId: newId("prj") };
    const envA = newId("env");
    const envB = newId("env");
    await audit.appendAudit(scope, {
      action: "secret.create",
      actorType: "user",
      actorId: "u",
      fields: { envId: envA },
    });
    await audit.appendAudit(scope, {
      action: "secret.create",
      actorType: "user",
      actorId: "u",
      fields: { envId: envB },
    });
    await audit.appendAudit(scope, {
      action: "project.update",
      actorType: "user",
      actorId: "u",
      fields: {},
    });

    const page = await audit.readAudit(scope, { envId: envA });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.envId).toBe(envA);
  });

  test("filters combined with pagination still walk every match once", async () => {
    const scope: AuditScope = { projectId: newId("prj") };
    for (let i = 0; i < 9; i++) {
      await audit.appendAudit(scope, {
        action: i % 3 === 0 ? "secret.delete" : "secret.update",
        actorType: "user",
        actorId: `usr_${i}`,
        fields: {},
      });
    }
    const matches: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await audit.readAudit(scope, {
        limit: 2,
        action: "secret.delete",
        ...(cursor === null ? {} : { cursor }),
      });
      matches.push(...page.entries.map((e) => e.actorId as string));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(matches).toEqual(["usr_6", "usr_3", "usr_0"]);
  });

  test("instance scope is separate from project scopes", async () => {
    const projectScope: AuditScope = { projectId: newId("prj") };
    const marker = newId("marker");
    const instanceId = await audit.appendAudit("instance", {
      action: "kek.rotate",
      actorType: "system",
      actorId: marker,
      fields: {},
    });
    await audit.appendAudit(projectScope, {
      action: "secret.create",
      actorType: "user",
      actorId: "usr_p",
      fields: {},
    });

    const instancePage = await audit.readAudit("instance", { limit: 1 });
    expect(instancePage.entries[0]?.id).toBe(instanceId);
    expect(instancePage.entries[0]?.actorId).toBe(marker);

    const projectPage = await audit.readAudit(projectScope, {});
    expect(projectPage.entries).toHaveLength(1);
    expect(projectPage.entries[0]?.actorId).toBe("usr_p");
  });

  test("MAXLEN ~ trims the stream when configured", async () => {
    const trimmed = createAuditLog(redis, { maxLen: 5 });
    const scope: AuditScope = { projectId: newId("prj") };
    // Approximate trimming (~) only removes whole macro-nodes (~100 entries),
    // so append enough to span multiple nodes and assert growth is bounded.
    const total = 150;
    for (let i = 0; i < total; i++) {
      await trimmed.appendAudit(scope, {
        action: "secret.update",
        actorType: "user",
        actorId: `usr_${i}`,
        fields: {},
      });
    }
    const len = (await redis.send("XLEN", [
      `audit:${scope.projectId}`,
    ])) as number;
    expect(len).toBeLessThan(total);
    expect(len).toBeGreaterThanOrEqual(5);
  });

  test("rejects reserved field names", async () => {
    const scope: AuditScope = { projectId: newId("prj") };
    await expect(
      audit.appendAudit(scope, {
        action: "secret.create",
        actorType: "user",
        actorId: "u",
        fields: { action: "spoofed" },
      }),
    ).rejects.toThrow(/reserved/);
  });
});
