import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  InstanceRole,
  ProjectRole,
  ServiceTokenScope,
} from "@secret-gardens/shared";
import { newId, openDb, runMigrations } from "../db";
import type { PrincipalResolution } from "./principal";
import { resolveProjectAccess } from "./projectGuard";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

function userResolution(
  userId: string,
  instanceRole: InstanceRole = "member",
): PrincipalResolution {
  return {
    principal: { type: "user", userId, instanceRole },
    errorCode: null,
    method: { kind: "session" },
  };
}

function serviceResolution(
  projectId: string,
  opts: {
    scope?: ServiceTokenScope;
    environmentIds?: string[] | null;
    tokenId?: string;
  } = {},
): PrincipalResolution {
  return {
    principal: {
      type: "service",
      tokenId: opts.tokenId ?? "st_1",
      projectId,
      scope: opts.scope ?? "read_write",
      environmentIds: opts.environmentIds ?? null,
    },
    errorCode: null,
    method: { kind: "service_token" },
  };
}

function insertProject(): string {
  const projectId = newId("prj");
  db.run(
    "INSERT INTO projects (id, name, slug, created_by, created_at, updated_at) VALUES (?, 'P', ?, 'usr_c', 1, 1)",
    [projectId, projectId],
  );
  return projectId;
}

function insertEnv(projectId: string): string {
  const envId = newId("env");
  db.run(
    "INSERT INTO environments (id, project_id, name, slug, position, created_at) VALUES (?, ?, 'E', ?, 0, 1)",
    [envId, projectId, envId],
  );
  return envId;
}

function addMember(projectId: string, userId: string, role: ProjectRole): void {
  db.run(
    "INSERT INTO project_memberships (id, project_id, user_id, role, created_at) VALUES (?, ?, ?, ?, 1)",
    [newId("mem"), projectId, userId, role],
  );
}

describe("resolveProjectAccess", () => {
  test("propagates principal resolution errors as unauthorized", () => {
    const projectId = insertProject();
    expect(
      resolveProjectAccess(
        db,
        { principal: null, errorCode: "invalid_token", method: null },
        projectId,
        "read",
      ),
    ).toEqual({ kind: "unauthorized", error: "invalid_token" });
    expect(
      resolveProjectAccess(
        db,
        { principal: null, errorCode: null, method: null },
        projectId,
        "read",
      ),
    ).toEqual({ kind: "unauthorized", error: "unauthorized" });
  });

  test("nonexistent project and non-member both yield not_found (no existence leak)", () => {
    const projectId = insertProject();
    const stranger = userResolution("usr_stranger");
    expect(
      resolveProjectAccess(db, stranger, "prj_nonexistent", "read").kind,
    ).toBe("not_found");
    expect(resolveProjectAccess(db, stranger, projectId, "read").kind).toBe(
      "not_found",
    );
    expect(resolveProjectAccess(db, stranger, undefined, "read").kind).toBe(
      "not_found",
    );
  });

  test("role ranks gate minRole: read < write < admin", () => {
    const projectId = insertProject();
    addMember(projectId, "usr_r", "read");
    addMember(projectId, "usr_w", "write");
    addMember(projectId, "usr_a", "admin");

    const matrix: Array<[string, ProjectRole, "ok" | "forbidden"]> = [
      ["usr_r", "read", "ok"],
      ["usr_r", "write", "forbidden"],
      ["usr_r", "admin", "forbidden"],
      ["usr_w", "read", "ok"],
      ["usr_w", "write", "ok"],
      ["usr_w", "admin", "forbidden"],
      ["usr_a", "read", "ok"],
      ["usr_a", "write", "ok"],
      ["usr_a", "admin", "ok"],
    ];
    for (const [userId, minRole, expected] of matrix) {
      const access = resolveProjectAccess(
        db,
        userResolution(userId),
        projectId,
        minRole,
      );
      expect(access.kind).toBe(expected);
    }
  });

  test("ok provides project row, principal, and resolved role", () => {
    const projectId = insertProject();
    addMember(projectId, "usr_w", "write");
    const access = resolveProjectAccess(
      db,
      userResolution("usr_w"),
      projectId,
      "write",
    );
    if (access.kind !== "ok")
      throw new Error(`expected ok, got ${access.kind}`);
    expect(access.project.id).toBe(projectId);
    expect(access.project.slug).toBe(projectId);
    expect(access.principal.userId).toBe("usr_w");
    expect(access.projectRole).toBe("write");
  });

  test("instance owner/admin are implicit project admins without membership", () => {
    const projectId = insertProject();
    for (const instanceRole of ["owner", "admin"] as const) {
      const access = resolveProjectAccess(
        db,
        userResolution("usr_boss", instanceRole),
        projectId,
        "admin",
      );
      if (access.kind !== "ok") {
        throw new Error(`expected ok, got ${access.kind}`);
      }
      expect(access.projectRole).toBe("admin");
    }
  });

  test("instance admin overrides a lower membership role", () => {
    const projectId = insertProject();
    addMember(projectId, "usr_boss", "read");
    const access = resolveProjectAccess(
      db,
      userResolution("usr_boss", "admin"),
      projectId,
      "admin",
    );
    expect(access.kind).toBe("ok");
  });
});

describe("resolveProjectAccess — service principals", () => {
  test("another project (existing or not) → not_found, never forbidden", () => {
    const own = insertProject();
    const other = insertProject();
    const resolution = serviceResolution(own);
    expect(resolveProjectAccess(db, resolution, other, "read").kind).toBe(
      "not_found",
    );
    expect(
      resolveProjectAccess(db, resolution, "prj_nonexistent", "read").kind,
    ).toBe("not_found");
    expect(resolveProjectAccess(db, resolution, undefined, "read").kind).toBe(
      "not_found",
    );
  });

  test("own project without a ServiceAccessSpec → forbidden", () => {
    const projectId = insertProject();
    expect(
      resolveProjectAccess(db, serviceResolution(projectId), projectId, "read")
        .kind,
    ).toBe("forbidden");
  });

  test("project.read grants ok_service on the own project only", () => {
    const projectId = insertProject();
    const access = resolveProjectAccess(
      db,
      serviceResolution(projectId, { scope: "read" }),
      projectId,
      "read",
      { action: "project.read" },
    );
    if (access.kind !== "ok_service") {
      throw new Error(`expected ok_service, got ${access.kind}`);
    }
    expect(access.project.id).toBe(projectId);
    expect(access.principal.type).toBe("service");
  });

  test("secrets actions validate the envId belongs to the project (else not_found)", () => {
    const projectId = insertProject();
    const foreignEnv = insertEnv(insertProject());
    const resolution = serviceResolution(projectId);
    expect(
      resolveProjectAccess(db, resolution, projectId, "read", {
        action: "secrets.read",
        envId: foreignEnv,
      }).kind,
    ).toBe("not_found");
    expect(
      resolveProjectAccess(db, resolution, projectId, "read", {
        action: "secrets.read",
      }).kind,
    ).toBe("not_found");
  });

  test("scope gates secrets.write: read scope forbidden, read_write ok", () => {
    const projectId = insertProject();
    const envId = insertEnv(projectId);
    expect(
      resolveProjectAccess(
        db,
        serviceResolution(projectId, { scope: "read" }),
        projectId,
        "write",
        { action: "secrets.write", envId },
      ).kind,
    ).toBe("forbidden");
    expect(
      resolveProjectAccess(
        db,
        serviceResolution(projectId, { scope: "read_write" }),
        projectId,
        "write",
        { action: "secrets.write", envId },
      ).kind,
    ).toBe("ok_service");
  });

  test("environmentIds scoping: listed env ok, unlisted env forbidden, null = all", () => {
    const projectId = insertProject();
    const envA = insertEnv(projectId);
    const envB = insertEnv(projectId);
    const scoped = serviceResolution(projectId, { environmentIds: [envA] });
    expect(
      resolveProjectAccess(db, scoped, projectId, "read", {
        action: "secrets.read",
        envId: envA,
      }).kind,
    ).toBe("ok_service");
    expect(
      resolveProjectAccess(db, scoped, projectId, "read", {
        action: "secrets.read",
        envId: envB,
      }).kind,
    ).toBe("forbidden");
    expect(
      resolveProjectAccess(
        db,
        serviceResolution(projectId, { environmentIds: null }),
        projectId,
        "read",
        { action: "secrets.read", envId: envB },
      ).kind,
    ).toBe("ok_service");
  });
});
