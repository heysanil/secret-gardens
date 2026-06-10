import type { ServicePrincipal } from "./principals";

export type ProjectRole = "admin" | "write" | "read";
export type InstanceRole = "owner" | "admin" | "member";

export type ProjectAction =
  | "secrets.read" // list keys + read values (pull/reveal)
  | "secrets.write" // set/delete/push/rollback
  | "versions.read" // version metadata
  | "versions.read_values" // decrypted historical values
  | "audit.read"
  | "project.manage"; // env CRUD, members, service tokens, rename/delete project, rotate DEK

const ROLE_PERMISSIONS: Record<ProjectRole, readonly ProjectAction[]> = {
  admin: [
    "secrets.read",
    "secrets.write",
    "versions.read",
    "versions.read_values",
    "audit.read",
    "project.manage",
  ],
  write: ["secrets.read", "secrets.write", "versions.read", "audit.read"],
  read: ["secrets.read", "versions.read", "audit.read"],
};

export function roleAllows(role: ProjectRole, action: ProjectAction): boolean {
  return ROLE_PERMISSIONS[role].includes(action);
}

export function serviceTokenAllows(
  p: ServicePrincipal,
  action: ProjectAction,
  projectId: string,
  envId: string,
): boolean {
  if (p.projectId !== projectId) return false;
  if (action === "secrets.write") {
    if (p.scope !== "read_write") return false;
  } else if (action !== "secrets.read") {
    return false;
  }
  if (p.environmentIds !== null) {
    return p.environmentIds.includes(envId);
  }
  return true;
}

export function resolveProjectRole(
  instanceRole: InstanceRole,
  membershipRole: ProjectRole | null,
): ProjectRole | null {
  if (instanceRole === "owner" || instanceRole === "admin") return "admin";
  return membershipRole;
}
