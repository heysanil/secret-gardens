import type { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { generateMasterKey, loadMasterKey } from "@secret-gardens/crypto";
import { TEST_REDIS_URL } from "../../test/testRedis";
import { newId, openDb, runMigrations } from "../db";
import { createRedis, type RedisLike } from "../redis/client";
import {
  createSecretStore,
  type SecretActor,
  type SecretStore,
} from "../redis/secretStore";
import { createDekService, type DekService } from "./dekService";
import {
  createSecretService,
  DecryptFailedError,
  type SecretService,
} from "./secretService";

const masterKey = loadMasterKey(generateMasterKey());
const redis = createRedis(TEST_REDIS_URL);
const actor: SecretActor = { type: "user", id: "usr_test" };

let db: Database;
let dekService: DekService;
let secretStore: SecretStore;
let service: SecretService;

beforeAll(async () => {
  await redis.connect();
  secretStore = createSecretStore(redis);
});

afterAll(() => {
  redis.close();
});

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  dekService = createDekService({ db, masterKey });
  service = createSecretService({ dekService, secretStore });
});

afterEach(() => {
  db.close();
});

function newProject(): string {
  const projectId = newId("prj");
  db.run(
    "INSERT INTO projects (id, name, slug, created_by, created_at, updated_at) VALUES (?, ?, ?, 'usr_t', 1, 1)",
    [projectId, "Test", projectId],
  );
  dekService.createProjectDek(projectId);
  return projectId;
}

describe("setSecret / getSecrets", () => {
  test("encrypts, stores, and round-trips a secret with metadata", async () => {
    const pid = newProject();
    const eid = newId("env");
    const created = await service.setSecret(
      pid,
      eid,
      "API_KEY",
      "hunter2",
      actor,
    );
    expect(created).toEqual({ version: 1, op: "create" });

    const metadata = await service.getSecrets(pid, eid, {
      includeValues: false,
    });
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.key).toBe("API_KEY");
    expect(metadata[0]?.version).toBe(1);
    expect(metadata[0]?.updatedBy).toBe(actor.id);
    expect(metadata[0]?.updatedAt).toBeGreaterThan(0);
    expect(metadata[0]?.value).toBeUndefined();

    const withValues = await service.getSecrets(pid, eid, {
      includeValues: true,
    });
    expect(withValues[0]?.value).toBe("hunter2");

    // At rest: ciphertext only, tagged with alg + dekV 1.
    const raw = await redis.hget(`secrets:${pid}:${eid}`, "API_KEY");
    const record = JSON.parse(raw as string) as {
      ct: string;
      dekV: number;
      alg: string;
    };
    expect(record.alg).toBe("aes-256-gcm:v1");
    expect(record.dekV).toBe(1);
    expect(Buffer.from(record.ct, "base64").toString("utf8")).not.toContain(
      "hunter2",
    );
  });

  test("second write to the same key is an update with version 2", async () => {
    const pid = newProject();
    const eid = newId("env");
    await service.setSecret(pid, eid, "K", "one", actor);
    const updated = await service.setSecret(pid, eid, "K", "two", actor);
    expect(updated).toEqual({ version: 2, op: "update" });
    const secrets = await service.getSecrets(pid, eid, { includeValues: true });
    expect(secrets[0]?.value).toBe("two");
  });
});

describe("setSecrets (bulk)", () => {
  test("classifies created / updated / deleted / unchanged exactly", async () => {
    const pid = newProject();
    const eid = newId("env");
    const first = await service.setSecrets(
      pid,
      eid,
      { A: "1", B: "2" },
      { prune: false, actor },
    );
    expect(first.created.map((c) => c.key)).toEqual(["A", "B"]);
    expect(first.updated).toEqual([]);
    expect(first.deleted).toEqual([]);
    expect(first.unchanged).toBe(0);

    // Identical re-push: everything unchanged, NO new versions.
    const repeat = await service.setSecrets(
      pid,
      eid,
      { A: "1", B: "2" },
      { prune: false, actor },
    );
    expect(repeat).toEqual({
      created: [],
      updated: [],
      deleted: [],
      unchanged: 2,
    });
    expect(await secretStore.listVersions(pid, eid, "A")).toHaveLength(1);
    expect(await secretStore.listVersions(pid, eid, "B")).toHaveLength(1);

    // Change B, add C, drop A with prune.
    const third = await service.setSecrets(
      pid,
      eid,
      { B: "2!", C: "3" },
      { prune: true, actor },
    );
    expect(third.created.map((c) => c.key)).toEqual(["C"]);
    expect(third.updated.map((c) => c.key)).toEqual(["B"]);
    expect(third.deleted.map((c) => c.key)).toEqual(["A"]);
    expect(third.unchanged).toBe(0);

    const final = await service.getSecrets(pid, eid, { includeValues: true });
    expect(final.map((s) => [s.key, s.value])).toEqual([
      ["B", "2!"],
      ["C", "3"],
    ]);
  });

  test("without prune, absent keys survive", async () => {
    const pid = newProject();
    const eid = newId("env");
    await service.setSecrets(pid, eid, { A: "1", B: "2" }, { actor });
    const result = await service.setSecrets(pid, eid, { B: "2" }, { actor });
    expect(result.deleted).toEqual([]);
    expect(result.unchanged).toBe(1);
    expect(await secretStore.listKeys(pid, eid)).toHaveLength(2);
  });

  test("empty payload with prune wipes the environment", async () => {
    const pid = newProject();
    const eid = newId("env");
    await service.setSecrets(pid, eid, { A: "1", B: "2" }, { actor });
    const result = await service.setSecrets(
      pid,
      eid,
      {},
      { prune: true, actor },
    );
    expect(result.deleted.map((c) => c.key)).toEqual(["A", "B"]);
    expect(await service.getSecrets(pid, eid, {})).toEqual([]);
  });
});

describe("getSecretVersions", () => {
  test("returns metadata, and decrypted per-version values when asked", async () => {
    const pid = newProject();
    const eid = newId("env");
    await service.setSecret(pid, eid, "K", "one", actor);
    await service.setSecret(pid, eid, "K", "two", actor);

    const metadata = await service.getSecretVersions(pid, eid, "K", {});
    expect(metadata.map((v) => v.version)).toEqual([2, 1]);
    expect(metadata.every((v) => v.value === undefined)).toBe(true);

    const withValues = await service.getSecretVersions(pid, eid, "K", {
      includeValues: true,
    });
    expect(withValues.map((v) => [v.version, v.value])).toEqual([
      [2, "two"],
      [1, "one"],
    ]);
  });

  test("uses exactly one redis round-trip regardless of version count", async () => {
    const pid = newProject();
    const eid = newId("env");
    await service.setSecret(pid, eid, "K", "one", actor);
    await service.setSecret(pid, eid, "K", "two", actor);
    await service.setSecret(pid, eid, "K", "three", actor);
    await service.deleteSecret(pid, eid, "K", actor);

    let commands = 0;
    const countingRedis: RedisLike = {
      connect: () => redis.connect(),
      close: () => {},
      send: (command, args) => {
        commands += 1;
        return redis.send(command, args);
      },
      hget: (key, field) => {
        commands += 1;
        return redis.hget(key, field);
      },
      hgetall: (key) => {
        commands += 1;
        return redis.hgetall(key);
      },
      hkeys: (key) => {
        commands += 1;
        return redis.hkeys(key);
      },
    };
    const countingService = createSecretService({
      dekService,
      secretStore: createSecretStore(countingRedis),
    });

    const versions = await countingService.getSecretVersions(pid, eid, "K", {
      includeValues: true,
    });
    expect(versions).toHaveLength(4);
    expect(versions.filter((v) => v.value !== undefined)).toHaveLength(3);
    expect(commands).toBe(1);

    commands = 0;
    await countingService.getSecretVersions(pid, eid, "K", {});
    expect(commands).toBe(1);
  });

  test("tombstone versions carry no value even with includeValues", async () => {
    const pid = newProject();
    const eid = newId("env");
    await service.setSecret(pid, eid, "K", "one", actor);
    await service.deleteSecret(pid, eid, "K", actor);
    const versions = await service.getSecretVersions(pid, eid, "K", {
      includeValues: true,
    });
    expect(versions.map((v) => [v.op, v.value])).toEqual([
      ["delete", undefined],
      ["create", "one"],
    ]);
  });
});

describe("deleteSecret", () => {
  test("tombstones an existing key, null for an absent one", async () => {
    const pid = newProject();
    const eid = newId("env");
    await service.setSecret(pid, eid, "K", "v", actor);
    expect(await service.deleteSecret(pid, eid, "K", actor)).toBe(2);
    expect(await service.getSecrets(pid, eid, {})).toEqual([]);
    expect(await service.deleteSecret(pid, eid, "K", actor)).toBeNull();
  });
});

describe("rollback", () => {
  test("appends the target version's ciphertext verbatim as a new rollback version", async () => {
    const pid = newProject();
    const eid = newId("env");
    await service.setSecret(pid, eid, "K", "one", actor);
    await service.setSecret(pid, eid, "K", "two", actor);
    await service.setSecret(pid, eid, "K", "three", actor);

    const result = await service.rollback(pid, eid, "K", 1, actor);
    expect(result).toEqual({ ok: true, version: 4 });

    const secrets = await service.getSecrets(pid, eid, { includeValues: true });
    expect(secrets[0]?.value).toBe("one");

    const v1 = await secretStore.getVersion(pid, eid, "K", 1);
    const v4 = await secretStore.getVersion(pid, eid, "K", 4);
    expect(v4?.op).toBe("rollback");
    expect(v4?.rollbackOf).toBe(1);
    // Ciphertext copied verbatim — same ct/nonce/tag/dekV/alg as v1.
    expect(v4?.ct).toBe(v1?.ct as string);
    expect(v4?.nonce).toBe(v1?.nonce as string);
    expect(v4?.tag).toBe(v1?.tag as string);
    expect(v4?.dekV).toBe(v1?.dekV as number);
    expect(v4?.alg).toBe(v1?.alg as string);
  });

  test("unknown version → not_found; tombstone target → tombstone", async () => {
    const pid = newProject();
    const eid = newId("env");
    await service.setSecret(pid, eid, "K", "one", actor);
    await service.deleteSecret(pid, eid, "K", actor);

    expect(await service.rollback(pid, eid, "K", 9, actor)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await service.rollback(pid, eid, "MISSING", 1, actor)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await service.rollback(pid, eid, "K", 2, actor)).toEqual({
      ok: false,
      reason: "tombstone",
    });
  });

  test("rolls back to a version written before a DEK rotation (retired dekV)", async () => {
    const pid = newProject();
    const eid = newId("env");
    await service.setSecret(pid, eid, "K", "pre-rotation", actor);
    await service.rotateProjectSecrets(pid, [eid]);
    await service.setSecret(pid, eid, "K", "post-rotation", actor);

    const result = await service.rollback(pid, eid, "K", 1, actor);
    expect(result).toEqual({ ok: true, version: 3 });
    const v3 = await secretStore.getVersion(pid, eid, "K", 3);
    expect(v3?.dekV).toBe(1); // preserved → decrypts via the retired DEK
    const secrets = await service.getSecrets(pid, eid, { includeValues: true });
    expect(secrets[0]?.value).toBe("pre-rotation");
  });
});

describe("rotateProjectSecrets", () => {
  test("re-encrypts every current secret across envs without version spam", async () => {
    const pid = newProject();
    const env1 = newId("env");
    const env2 = newId("env");
    await service.setSecrets(pid, env1, { A: "a", B: "b" }, { actor });
    await service.setSecret(pid, env2, "C", "c", actor);
    await service.setSecret(pid, env1, "A", "a2", actor); // A now at v2

    const result = await service.rotateProjectSecrets(pid, [env1, env2]);
    expect(result).toEqual({
      oldVersion: 1,
      newVersion: 2,
      secretsRewritten: 3,
    });

    // Current records all dekV 2 with v unchanged; values still decrypt.
    for (const [envId, key, v, value] of [
      [env1, "A", 2, "a2"],
      [env1, "B", 1, "b"],
      [env2, "C", 1, "c"],
    ] as const) {
      const raw = await redis.hget(`secrets:${pid}:${envId}`, key);
      const record = JSON.parse(raw as string) as { v: number; dekV: number };
      expect(record.dekV).toBe(2);
      expect(record.v).toBe(v);
      const secrets = await service.getSecrets(pid, envId, {
        includeValues: true,
      });
      expect(secrets.find((s) => s.key === key)?.value).toBe(value);
    }

    // No version history growth.
    expect(await secretStore.listVersions(pid, env1, "A")).toHaveLength(2);
    expect(await secretStore.listVersions(pid, env1, "B")).toHaveLength(1);

    // Old versions keep dekV 1 and still decrypt via the retired DEK.
    const versions = await service.getSecretVersions(pid, env1, "A", {
      includeValues: true,
    });
    expect(versions.map((v) => [v.version, v.value])).toEqual([
      [2, "a2"],
      [1, "a"],
    ]);

    // Subsequent writes use the new DEK.
    await service.setSecret(pid, env1, "NEW", "n", actor);
    const raw = await redis.hget(`secrets:${pid}:${env1}`, "NEW");
    expect((JSON.parse(raw as string) as { dekV: number }).dekV).toBe(2);
  });
});

describe("decrypt failures", () => {
  test("ciphertext transplanted onto another key throws DecryptFailedError", async () => {
    const pid = newProject();
    const eid = newId("env");
    await service.setSecret(pid, eid, "SOURCE", "leak-me", actor);
    await service.setSecret(pid, eid, "TARGET", "innocent", actor);

    const source = await redis.hget(`secrets:${pid}:${eid}`, "SOURCE");
    await redis.send("HSET", [
      `secrets:${pid}:${eid}`,
      "TARGET",
      source as string,
    ]);

    expect(
      service.getSecrets(pid, eid, { includeValues: true }),
    ).rejects.toThrow(DecryptFailedError);
  });

  test("a record pointing at a nonexistent DEK version throws DecryptFailedError", async () => {
    const pid = newProject();
    const eid = newId("env");
    await service.setSecret(pid, eid, "K", "v", actor);
    const raw = await redis.hget(`secrets:${pid}:${eid}`, "K");
    const record = JSON.parse(raw as string) as { dekV: number };
    record.dekV = 99;
    await redis.send("HSET", [
      `secrets:${pid}:${eid}`,
      "K",
      JSON.stringify(record),
    ]);
    expect(
      service.getSecrets(pid, eid, { includeValues: true }),
    ).rejects.toThrow(DecryptFailedError);
  });

  test("DecryptFailedError messages never contain plaintext", async () => {
    const pid = newProject();
    const eid = newId("env");
    await service.setSecret(pid, eid, "A", "topsecret-a", actor);
    await service.setSecret(pid, eid, "B", "topsecret-b", actor);
    const a = await redis.hget(`secrets:${pid}:${eid}`, "A");
    await redis.send("HSET", [`secrets:${pid}:${eid}`, "B", a as string]);
    try {
      await service.getSecrets(pid, eid, { includeValues: true });
      throw new Error("expected DecryptFailedError");
    } catch (err) {
      expect(err).toBeInstanceOf(DecryptFailedError);
      expect((err as Error).message).not.toContain("topsecret");
    }
  });
});
