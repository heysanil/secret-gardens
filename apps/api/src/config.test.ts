import { describe, expect, test } from "bun:test";
import { generateMasterKey } from "@safe/crypto";
import { ConfigError, loadConfig } from "./config";

const validKey = generateMasterKey();

describe("loadConfig", () => {
  test("applies defaults when only SAFE_MASTER_KEY is set", () => {
    const config = loadConfig({ SAFE_MASTER_KEY: validKey });
    expect(config.port).toBe(3000);
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.dbPath).toBe("./data/safe.db");
    expect(config.publicUrl).toBe("http://localhost:3000");
    expect(config.auditMaxLen).toBeNull();
    expect(config.masterKey.kekId).toMatch(/^[0-9a-f]{16}$/);
  });

  test("honors explicit values", () => {
    const config = loadConfig({
      SAFE_MASTER_KEY: validKey,
      PORT: "8080",
      REDIS_URL: "redis://redis:6379",
      SAFE_DB_PATH: "/data/safe.db",
      SAFE_PUBLIC_URL: "https://safe.example.com",
      SAFE_AUDIT_MAXLEN: "10000",
    });
    expect(config.port).toBe(8080);
    expect(config.redisUrl).toBe("redis://redis:6379");
    expect(config.dbPath).toBe("/data/safe.db");
    expect(config.publicUrl).toBe("https://safe.example.com");
    expect(config.auditMaxLen).toBe(10000);
  });

  describe("SAFE_MASTER_KEY validation", () => {
    const badKeys: Array<[string, string | undefined]> = [
      ["missing", undefined],
      ["empty", ""],
      ["not base64", "!!!not-base64!!!"],
      ["wrong length", Buffer.alloc(16).toString("base64")],
    ];

    for (const [label, value] of badKeys) {
      test(`rejects ${label} key with an actionable message`, () => {
        const env: Record<string, string | undefined> = {};
        if (value !== undefined) {
          env.SAFE_MASTER_KEY = value;
        }
        expect(() => loadConfig(env)).toThrow(ConfigError);
        try {
          loadConfig(env);
        } catch (err) {
          const message = (err as Error).message;
          expect(message).toContain("SAFE_MASTER_KEY");
          expect(message).toContain("scripts/setup.sh");
        }
      });
    }

    test("never echoes the provided key value in errors", () => {
      const secretLooking = "this-is-my-secret-key-value-do-not-echo";
      try {
        loadConfig({ SAFE_MASTER_KEY: secretLooking });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as Error).message).not.toContain(secretLooking);
      }
    });
  });

  describe("SAFE_AUDIT_MAXLEN validation", () => {
    for (const bad of ["abc", "0", "-5", "1.5", "", "10x"]) {
      test(`rejects ${JSON.stringify(bad)}`, () => {
        expect(() =>
          loadConfig({ SAFE_MASTER_KEY: validKey, SAFE_AUDIT_MAXLEN: bad }),
        ).toThrow(/SAFE_AUDIT_MAXLEN must be a positive integer/);
      });
    }

    test("accepts a positive integer", () => {
      const config = loadConfig({
        SAFE_MASTER_KEY: validKey,
        SAFE_AUDIT_MAXLEN: "500",
      });
      expect(config.auditMaxLen).toBe(500);
    });
  });

  describe("PORT validation", () => {
    for (const bad of ["abc", "0", "-1", "3.5"]) {
      test(`rejects ${JSON.stringify(bad)}`, () => {
        expect(() =>
          loadConfig({ SAFE_MASTER_KEY: validKey, PORT: bad }),
        ).toThrow(ConfigError);
      });
    }

    test("rejects ports above 65535", () => {
      expect(() =>
        loadConfig({ SAFE_MASTER_KEY: validKey, PORT: "70000" }),
      ).toThrow(/PORT must be at most 65535/);
    });
  });
});
