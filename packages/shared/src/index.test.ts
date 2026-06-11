import { describe, expect, test } from "bun:test";
import {
  AUDIT_ACTIONS,
  classifyToken,
  MAX_BULK_SECRETS,
  MAX_SECRET_KEY_LENGTH,
  MAX_SECRET_VALUE_BYTES,
  parseDotenv,
  parseSafeConfig,
  resolveProjectRole,
  roleAllows,
  SAFE_CONFIG_FILENAME,
  SafeConfigError,
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
      parseSafeConfig,
      classifyToken,
      validateSecretKey,
      validateSecretValue,
    ]) {
      expect(typeof fn).toBe("function");
    }
  });

  test("constants are exported", () => {
    expect(AUDIT_ACTIONS.length).toBe(20);
    expect(SAFE_CONFIG_FILENAME).toBe(".safe.json");
    expect(TOKEN_PREFIXES.serviceToken).toBe("safe_st_");
    expect(SECRET_KEY_PATTERN).toBeInstanceOf(RegExp);
    expect(MAX_SECRET_KEY_LENGTH).toBe(256);
    expect(MAX_SECRET_VALUE_BYTES).toBe(64 * 1024);
    expect(MAX_BULK_SECRETS).toBe(1000);
  });

  test("SafeConfigError is an Error subclass", () => {
    const err = new SafeConfigError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SafeConfigError");
    expect(err.message).toBe("boom");
  });
});
