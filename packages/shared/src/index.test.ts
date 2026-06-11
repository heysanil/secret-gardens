import { describe, expect, test } from "bun:test";
import {
  AUDIT_ACTIONS,
  classifyToken,
  GARDENS_CONFIG_FILENAME,
  GardensConfigError,
  MAX_BULK_SECRETS,
  MAX_SECRET_KEY_LENGTH,
  MAX_SECRET_VALUE_BYTES,
  parseDotenv,
  parseGardensConfig,
  resolveProjectRole,
  roleAllows,
  SECRET_KEY_PATTERN,
  serializeDotenv,
  serviceTokenAllows,
  TOKEN_PREFIXES,
  validateSecretKey,
  validateSecretValue,
} from "./index";

describe("index re-exports", () => {
  test("functions are exported", () => {
    for (const fn of [
      roleAllows,
      serviceTokenAllows,
      resolveProjectRole,
      parseDotenv,
      serializeDotenv,
      parseGardensConfig,
      classifyToken,
      validateSecretKey,
      validateSecretValue,
    ]) {
      expect(typeof fn).toBe("function");
    }
  });

  test("constants are exported", () => {
    expect(AUDIT_ACTIONS.length).toBe(20);
    expect(GARDENS_CONFIG_FILENAME).toBe(".gardens.json");
    expect(TOKEN_PREFIXES.serviceToken).toBe("sg_st_");
    expect(SECRET_KEY_PATTERN).toBeInstanceOf(RegExp);
    expect(MAX_SECRET_KEY_LENGTH).toBe(256);
    expect(MAX_SECRET_VALUE_BYTES).toBe(64 * 1024);
    expect(MAX_BULK_SECRETS).toBe(1000);
  });

  test("GardensConfigError is an Error subclass", () => {
    const err = new GardensConfigError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GardensConfigError");
    expect(err.message).toBe("boom");
  });
});
