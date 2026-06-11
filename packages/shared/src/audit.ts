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

/**
 * The subset of AUDIT_ACTIONS that can appear in a per-project audit stream.
 * auth.login, auth.failed_login and kek.rotate are instance-only — they are
 * only ever appended to the instance stream — so project-scoped filters
 * should not offer them. AUDIT_ACTIONS remains the full vocabulary.
 */
export const PROJECT_AUDIT_ACTIONS: readonly AuditAction[] =
  AUDIT_ACTIONS.filter(
    (action) =>
      action !== "auth.login" &&
      action !== "auth.failed_login" &&
      action !== "kek.rotate",
  );

export type AuditActorType = "user" | "service_token" | "system";
