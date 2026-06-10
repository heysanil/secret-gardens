import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TEST_REDIS_URL } from "../../test/testRedis";
import { newId } from "../db/ids";
import { createRedis, type RedisLike } from "./client";
import {
  createSecretStore,
  type SecretActor,
  type SecretCipherPayload,
  type SecretStore,
} from "./secretStore";

const redis = createRedis(TEST_REDIS_URL);
let store: SecretStore;

beforeAll(async () => {
  await redis.connect();
  store = createSecretStore(redis);
});

afterAll(() => {
  redis.close();
});

const actor: SecretActor = { type: "user", id: "usr_test" };

function payload(marker: string): SecretCipherPayload {
  return {
    ct: Buffer.from(`ciphertext-${marker}`).toString("base64"),
    nonce: Buffer.alloc(12, 1).toString("base64"),
    tag: Buffer.alloc(16, 2).toString("base64"),
    dekV: 1,
    alg: "aes-256-gcm:v1",
  };
}

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

describe("secretStore", () => {
  test("write → getCurrent round-trip preserves the opaque payload", async () => {
    const pid = newId("prj");
    const eid = newId("env");
    const p = payload("rt");
    const before = Date.now();
    const version = await store.writeSecret(
      pid,
      eid,
      "API_KEY",
      p,
      actor,
      "create",
    );
    expect(version).toBe(1);

    const current = await store.getCurrent(pid, eid, "API_KEY");
    expect(current).not.toBeNull();
    expect(current?.v).toBe(1);
    expect(current?.ct).toBe(p.ct);
    expect(current?.nonce).toBe(p.nonce);
    expect(current?.tag).toBe(p.tag);
    expect(current?.dekV).toBe(p.dekV);
    expect(current?.alg).toBe(p.alg);
    expect(current?.updatedBy).toBe(actor.id);
    expect(current?.updatedAt).toBeGreaterThanOrEqual(before);
    expect(current?.updatedAt).toBeLessThanOrEqual(Date.now());
  });

  test("repeated writes produce version sequence 1, 2, 3", async () => {
    const pid = newId("prj");
    const eid = newId("env");
    expect(
      await store.writeSecret(pid, eid, "K", payload("a"), actor, "create"),
    ).toBe(1);
    expect(
      await store.writeSecret(pid, eid, "K", payload("b"), actor, "update"),
    ).toBe(2);
    expect(
      await store.writeSecret(pid, eid, "K", payload("c"), actor, "update"),
    ).toBe(3);
    const current = await store.getCurrent(pid, eid, "K");
    expect(current?.v).toBe(3);
    expect(current?.ct).toBe(payload("c").ct);
  });

  test("ATOMICITY: 25 concurrent writes to the same key yield versions 1..25 exactly once", async () => {
    const pid = newId("prj");
    const eid = newId("env");
    const key = "CONCURRENT_KEY";
    const n = 25;

    const payloads = Array.from({ length: n }, (_, i) => payload(`c${i}`));
    const versions = await Promise.all(
      payloads.map((p) => store.writeSecret(pid, eid, key, p, actor, "update")),
    );

    // Every version 1..25 assigned exactly once.
    expect([...versions].sort((a, b) => a - b)).toEqual(
      Array.from({ length: n }, (_, i) => i + 1),
    );

    // Version hash holds exactly fields "1".."25", each once.
    const verHash = await redis.hgetall(`secretver:${pid}:${eid}:${key}`);
    const fields = Object.keys(verHash)
      .map(Number)
      .sort((a, b) => a - b);
    expect(fields).toEqual(Array.from({ length: n }, (_, i) => i + 1));

    // Stored current JSON parses, its v equals the max version, and the
    // ciphertext belongs to the write that won version 25.
    const raw = await redis.hget(`secrets:${pid}:${eid}`, key);
    expect(raw).not.toBeNull();
    const current = JSON.parse(raw as string);
    expect(current.v).toBe(n);
    const winnerIndex = versions.indexOf(n);
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(current.ct).toBe(payloads[winnerIndex]?.ct);
  });

  test("delete writes a tombstone version and removes the current entry", async () => {
    const pid = newId("prj");
    const eid = newId("env");
    await store.writeSecret(pid, eid, "DOOMED", payload("d"), actor, "create");

    const tombstoneVersion = await store.deleteSecret(
      pid,
      eid,
      "DOOMED",
      actor,
    );
    expect(tombstoneVersion).toBe(2);

    expect(await store.getCurrent(pid, eid, "DOOMED")).toBeNull();
    expect(await redis.hget(`secrets:${pid}:${eid}`, "DOOMED")).toBeNull();

    const tombstone = await store.getVersion(pid, eid, "DOOMED", 2);
    expect(tombstone?.op).toBe("delete");
    expect(tombstone?.ct).toBeUndefined();
    expect(tombstone?.actorType).toBe(actor.type);
    expect(tombstone?.actorId).toBe(actor.id);
    expect(tombstone?.ts).toBeGreaterThan(0);
  });

  test("deleting an absent key returns null and writes nothing", async () => {
    const pid = newId("prj");
    const eid = newId("env");
    expect(
      await store.deleteSecret(pid, eid, "NEVER_EXISTED", actor),
    ).toBeNull();
    expect(
      await scanCount(redis, `secretver:${pid}:${eid}:NEVER_EXISTED`),
    ).toBe(0);
    expect(
      await scanCount(redis, `secretvctr:${pid}:${eid}:NEVER_EXISTED`),
    ).toBe(0);
  });

  test("getAllCurrent and listKeys cover every live secret", async () => {
    const pid = newId("prj");
    const eid = newId("env");
    await store.writeSecret(pid, eid, "A", payload("a"), actor, "create");
    await store.writeSecret(pid, eid, "B", payload("b"), actor, "create");
    await store.writeSecret(pid, eid, "C", payload("c"), actor, "create");
    await store.deleteSecret(pid, eid, "B", actor);

    const keys = await store.listKeys(pid, eid);
    expect([...keys].sort()).toEqual(["A", "C"]);

    const all = await store.getAllCurrent(pid, eid);
    expect(Object.keys(all).sort()).toEqual(["A", "C"]);
    expect(all.A?.ct).toBe(payload("a").ct);
    expect(all.C?.v).toBe(1);
  });

  test("listVersions returns metadata only, newest first, with hasValue flags", async () => {
    const pid = newId("prj");
    const eid = newId("env");
    const key = "HISTORY";
    await store.writeSecret(pid, eid, key, payload("v1"), actor, "create");
    await store.writeSecret(pid, eid, key, payload("v2"), actor, "update");
    await store.deleteSecret(pid, eid, key, actor);
    await store.writeSecret(pid, eid, key, payload("v1"), actor, "rollback", 1);

    const versions = await store.listVersions(pid, eid, key);
    expect(versions.map((v) => v.version)).toEqual([4, 3, 2, 1]);
    expect(versions.map((v) => v.op)).toEqual([
      "rollback",
      "delete",
      "update",
      "create",
    ]);
    expect(versions.map((v) => v.hasValue)).toEqual([true, false, true, true]);
    expect(versions[0]?.rollbackOf).toBe(1);
    expect(versions[1]?.rollbackOf).toBeUndefined();
    for (const v of versions) {
      expect(v).not.toContainAnyKeys(["ct", "nonce", "tag", "dekV", "alg"]);
      expect(v.actorType).toBe(actor.type);
      expect(v.actorId).toBe(actor.id);
      expect(v.ts).toBeGreaterThan(0);
    }
  });

  test("getVersion returns the exact full record, null when missing", async () => {
    const pid = newId("prj");
    const eid = newId("env");
    const p1 = payload("first");
    await store.writeSecret(pid, eid, "X", p1, actor, "create");
    await store.writeSecret(pid, eid, "X", payload("second"), actor, "update");

    const v1 = await store.getVersion(pid, eid, "X", 1);
    expect(v1?.op).toBe("create");
    expect(v1?.ct).toBe(p1.ct);
    expect(v1?.nonce).toBe(p1.nonce);
    expect(v1?.tag).toBe(p1.tag);
    expect(v1?.dekV).toBe(p1.dekV);
    expect(v1?.alg).toBe(p1.alg);

    expect(await store.getVersion(pid, eid, "X", 99)).toBeNull();
  });

  test("rollback writes carry op rollback and rollbackOf", async () => {
    const pid = newId("prj");
    const eid = newId("env");
    const p1 = payload("orig");
    await store.writeSecret(pid, eid, "R", p1, actor, "create");
    await store.writeSecret(pid, eid, "R", payload("new"), actor, "update");
    const v = await store.writeSecret(pid, eid, "R", p1, actor, "rollback", 1);
    expect(v).toBe(3);
    const record = await store.getVersion(pid, eid, "R", 3);
    expect(record?.op).toBe("rollback");
    expect(record?.rollbackOf).toBe(1);
    expect((await store.getCurrent(pid, eid, "R"))?.ct).toBe(p1.ct);
  });

  test("rewriteCurrent swaps ciphertext in place without touching version state", async () => {
    const pid = newId("prj");
    const eid = newId("env");
    const key = "ROTATED";
    await store.writeSecret(pid, eid, key, payload("old"), actor, "create");
    const before = await store.getCurrent(pid, eid, key);

    const next: SecretCipherPayload = { ...payload("new"), dekV: 2 };
    expect(await store.rewriteCurrent(pid, eid, key, next)).toBe(true);

    const after = await store.getCurrent(pid, eid, key);
    expect(after?.ct).toBe(next.ct);
    expect(after?.nonce).toBe(next.nonce);
    expect(after?.tag).toBe(next.tag);
    expect(after?.dekV).toBe(2);
    expect(after?.alg).toBe(next.alg);
    // Version pointer and update metadata are preserved verbatim.
    expect(after?.v).toBe(before?.v as number);
    expect(after?.updatedAt).toBe(before?.updatedAt as number);
    expect(after?.updatedBy).toBe(before?.updatedBy as string);

    // No new version, no counter bump.
    const versions = await store.listVersions(pid, eid, key);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
    const counter = await redis.send("GET", [
      `secretvctr:${pid}:${eid}:${key}`,
    ]);
    expect(String(counter)).toBe("1");
    // The historical version still holds the original ciphertext.
    expect((await store.getVersion(pid, eid, key, 1))?.ct).toBe(
      payload("old").ct,
    );
  });

  test("rewriteCurrent returns false for an absent key and writes nothing", async () => {
    const pid = newId("prj");
    const eid = newId("env");
    expect(await store.rewriteCurrent(pid, eid, "MISSING", payload("x"))).toBe(
      false,
    );
    expect(await scanCount(redis, `secrets:${pid}:${eid}`)).toBe(0);
    expect(await scanCount(redis, `secretver:${pid}:${eid}:*`)).toBe(0);
  });

  test("deleteEnvironmentData removes only that environment's keys", async () => {
    const pid = newId("prj");
    const env1 = newId("env");
    const env2 = newId("env");
    await store.writeSecret(pid, env1, "A", payload("a"), actor, "create");
    await store.writeSecret(pid, env1, "B", payload("b"), actor, "create");
    await store.writeSecret(pid, env2, "C", payload("c"), actor, "create");

    await store.deleteEnvironmentData(pid, env1);

    expect(await scanCount(redis, `secrets:${pid}:${env1}`)).toBe(0);
    expect(await scanCount(redis, `secretver:${pid}:${env1}:*`)).toBe(0);
    expect(await scanCount(redis, `secretvctr:${pid}:${env1}:*`)).toBe(0);

    // The sibling environment is untouched.
    expect((await store.getCurrent(pid, env2, "C"))?.ct).toBe(payload("c").ct);
    expect(await scanCount(redis, `secretver:${pid}:${env2}:*`)).toBe(1);
  });

  test("deleteProjectData removes all of a project's keys and nothing else", async () => {
    const pidA = newId("prj");
    const pidB = newId("prj");
    const eid = newId("env");
    await store.writeSecret(pidA, eid, "A1", payload("a1"), actor, "create");
    await store.writeSecret(pidA, eid, "A2", payload("a2"), actor, "create");
    await store.writeSecret(pidB, eid, "B1", payload("b1"), actor, "create");

    await store.deleteProjectData(pidA);

    expect(await scanCount(redis, `secrets:${pidA}:*`)).toBe(0);
    expect(await scanCount(redis, `secretver:${pidA}:*`)).toBe(0);
    expect(await scanCount(redis, `secretvctr:${pidA}:*`)).toBe(0);

    // The other project is untouched.
    expect((await store.getCurrent(pidB, eid, "B1"))?.ct).toBe(
      payload("b1").ct,
    );
    expect(await scanCount(redis, `secretvctr:${pidB}:*`)).toBe(1);
  });
});
