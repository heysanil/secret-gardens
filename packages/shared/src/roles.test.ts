import { describe, expect, test } from "bun:test";
import type { ServicePrincipal } from "./principals";
import {
  type InstanceRole,
  type ProjectAction,
  type ProjectRole,
  resolveProjectRole,
  roleAllows,
  serviceTokenAllows,
} from "./roles";

const ALL_ROLES: readonly ProjectRole[] = ["admin", "write", "read"];
const ALL_ACTIONS: readonly ProjectAction[] = [
  "secrets.read",
  "secrets.write",
  "versions.read",
  "versions.read_values",
  "audit.read",
  "project.manage",
];

describe("roleAllows", () => {
  const expected: Record<ProjectRole, Record<ProjectAction, boolean>> = {
    admin: {
      "secrets.read": true,
      "secrets.write": true,
      "versions.read": true,
      "versions.read_values": true,
      "audit.read": true,
      "project.manage": true,
    },
    write: {
      "secrets.read": true,
      "secrets.write": true,
      "versions.read": true,
      "versions.read_values": false,
      "audit.read": true,
      "project.manage": false,
    },
    read: {
      "secrets.read": true,
      "secrets.write": false,
      "versions.read": true,
      "versions.read_values": false,
      "audit.read": true,
      "project.manage": false,
    },
  };

  for (const role of ALL_ROLES) {
    for (const action of ALL_ACTIONS) {
      test(`${role} × ${action} => ${expected[role][action]}`, () => {
        expect(roleAllows(role, action)).toBe(expected[role][action]);
      });
    }
  }
});

describe("resolveProjectRole", () => {
  const memberships: readonly (ProjectRole | null)[] = [
    "admin",
    "write",
    "read",
    null,
  ];

  for (const instanceRole of [
    "owner",
    "admin",
  ] as const satisfies readonly InstanceRole[]) {
    for (const membership of memberships) {
      test(`${instanceRole} × ${membership} => admin`, () => {
        expect(resolveProjectRole(instanceRole, membership)).toBe("admin");
      });
    }
  }

  for (const membership of memberships) {
    test(`member × ${membership} => ${membership}`, () => {
      expect(resolveProjectRole("member", membership)).toBe(membership);
    });
  }
});

describe("serviceTokenAllows", () => {
  function principal(
    overrides: Partial<Omit<ServicePrincipal, "type">> = {},
  ): ServicePrincipal {
    return {
      type: "service",
      tokenId: "tok_1",
      projectId: "proj_1",
      scope: "read",
      environmentIds: null,
      ...overrides,
    };
  }

  describe("project scoping", () => {
    test("denies every action when projectId does not match, even with read_write scope", () => {
      const p = principal({ scope: "read_write" });
      for (const action of ALL_ACTIONS) {
        expect(serviceTokenAllows(p, action, "proj_other", "env_1")).toBe(
          false,
        );
      }
    });
  });

  describe("scope: read", () => {
    const p = principal({ scope: "read" });

    test("allows secrets.read on the matching project", () => {
      expect(serviceTokenAllows(p, "secrets.read", "proj_1", "env_1")).toBe(
        true,
      );
    });

    test("denies secrets.write", () => {
      expect(serviceTokenAllows(p, "secrets.write", "proj_1", "env_1")).toBe(
        false,
      );
    });
  });

  describe("scope: read_write", () => {
    const p = principal({ scope: "read_write" });

    test("allows secrets.read on the matching project", () => {
      expect(serviceTokenAllows(p, "secrets.read", "proj_1", "env_1")).toBe(
        true,
      );
    });

    test("allows secrets.write on the matching project", () => {
      expect(serviceTokenAllows(p, "secrets.write", "proj_1", "env_1")).toBe(
        true,
      );
    });
  });

  describe("non-secrets actions are always denied", () => {
    const nonSecretActions = ALL_ACTIONS.filter(
      (a) => a !== "secrets.read" && a !== "secrets.write",
    );

    for (const action of nonSecretActions) {
      test(`${action} denied even with read_write scope, matching project, all envs`, () => {
        const p = principal({ scope: "read_write", environmentIds: null });
        expect(serviceTokenAllows(p, action, "proj_1", "env_1")).toBe(false);
      });
    }
  });

  describe("environment scoping", () => {
    test("environmentIds null means all environments", () => {
      const p = principal({ environmentIds: null });
      expect(
        serviceTokenAllows(p, "secrets.read", "proj_1", "env_anything"),
      ).toBe(true);
    });

    test("envId included in environmentIds is allowed", () => {
      const p = principal({ environmentIds: ["env_a", "env_b"] });
      expect(serviceTokenAllows(p, "secrets.read", "proj_1", "env_a")).toBe(
        true,
      );
      expect(serviceTokenAllows(p, "secrets.read", "proj_1", "env_b")).toBe(
        true,
      );
    });

    test("envId not included in environmentIds is denied", () => {
      const p = principal({ environmentIds: ["env_a"] });
      expect(serviceTokenAllows(p, "secrets.read", "proj_1", "env_c")).toBe(
        false,
      );
    });

    test("env restriction also applies to secrets.write", () => {
      const p = principal({ scope: "read_write", environmentIds: ["env_a"] });
      expect(serviceTokenAllows(p, "secrets.write", "proj_1", "env_a")).toBe(
        true,
      );
      expect(serviceTokenAllows(p, "secrets.write", "proj_1", "env_b")).toBe(
        false,
      );
    });

    test("env scoping is always enforced for env-restricted tokens", () => {
      // envId is a required parameter, so callers cannot bypass the check;
      // anything outside the allow-list is denied for every secrets action.
      const p = principal({ scope: "read_write", environmentIds: ["env_a"] });
      for (const envId of ["env_b", "ENV_A", "", "env_a "]) {
        expect(serviceTokenAllows(p, "secrets.read", "proj_1", envId)).toBe(
          false,
        );
        expect(serviceTokenAllows(p, "secrets.write", "proj_1", envId)).toBe(
          false,
        );
      }
      expect(serviceTokenAllows(p, "secrets.read", "proj_1", "env_a")).toBe(
        true,
      );
    });

    test("empty environmentIds array denies every explicit envId", () => {
      const p = principal({ environmentIds: [] });
      expect(serviceTokenAllows(p, "secrets.read", "proj_1", "env_a")).toBe(
        false,
      );
    });
  });
});
