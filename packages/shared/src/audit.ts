export const AUDIT_ACTIONS = [
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
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditActorType = "user" | "service_token" | "system";
