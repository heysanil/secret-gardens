import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { InstanceRole, ProjectRole } from "@safe/shared";
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
        { principal: null, errorCode: "invalid_token" },
        projectId,
        "read",
      ),
    ).toEqual({ kind: "unauthorized", error: "invalid_token" });
    expect(
      resolveProjectAccess(
        db,
        { principal: null, errorCode: null },
        projectId,
        "read",
      ),
    ).toEqual({ kind: "unauthorized", error: "unauthorized" });
  });

  test("service principals are rejected until Phase 6", () => {
    const projectId = insertProject();
    const resolution: PrincipalResolution = {
      principal: {
        type: "service",
        tokenId: "st_1",
        projectId,
        scope: "read_write",
        environmentIds: null,
      },
      errorCode: null,
    };
    expect(resolveProjectAccess(db, resolution, projectId, "read")).toEqual({
      kind: "service_unsupported",
    });
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
