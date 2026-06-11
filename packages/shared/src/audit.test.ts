import { describe, expect, test } from "bun:test";
import { AUDIT_ACTIONS, PROJECT_AUDIT_ACTIONS } from "./audit";

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

describe("PROJECT_AUDIT_ACTIONS", () => {
  test("is AUDIT_ACTIONS minus the instance-only actions, in order", () => {
    const instanceOnly = ["auth.login", "auth.failed_login", "kek.rotate"];
    expect(PROJECT_AUDIT_ACTIONS).toEqual(
      AUDIT_ACTIONS.filter((a) => !instanceOnly.includes(a)),
    );
  });

  test("excludes every instance-only action", () => {
    for (const action of ["auth.login", "auth.failed_login", "kek.rotate"]) {
      expect(PROJECT_AUDIT_ACTIONS).not.toContain(action);
    }
  });

  test("is a strict subset of AUDIT_ACTIONS", () => {
    const full = new Set<string>(AUDIT_ACTIONS);
    for (const action of PROJECT_AUDIT_ACTIONS) {
      expect(full.has(action)).toBe(true);
    }
    expect(PROJECT_AUDIT_ACTIONS.length).toBeLessThan(AUDIT_ACTIONS.length);
  });
});
