import { describe, expect, test } from "bun:test";
import { AUDIT_ACTIONS } from "./audit";

describe("AUDIT_ACTIONS", () => {
  test("contains exactly the expected actions in order", () => {
    expect(AUDIT_ACTIONS).toEqual([
      "project.create",
      "project.update",
      "project.delete",
      "env.create",
      "env.update",
      "env.delete",
      "secret.create",
      "secret.update",
      "secret.delete",
      "secret.rollback",
      "secrets.read",
      "member.add",
      "member.update",
      "member.remove",
      "token.create",
      "token.revoke",
      "auth.login",
      "auth.failed_login",
      "dek.rotate",
      "kek.rotate",
    ]);
  });

  test("has no duplicates", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });
});
