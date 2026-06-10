import type { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import type { Config } from "../config";
import { ALLOW_SIGNUP_KEY, setInstanceSetting } from "../db/instance";
import type { AuditLog } from "../redis/audit";

export {
  createPrincipalResolver,
  type PrincipalDeps,
  type PrincipalResolution,
  parseInstanceRole,
  principalPlugin,
  resolvePrincipal,
} from "./principal";

export interface AuthDeps {
  db: Database;
  config: Config;
  audit: AuditLog;
}

/**
 * OWASP-recommended argon2id parameters (19 MiB, t=2) — deliberately not
 * Bun's 64 MiB default, which is too heavy per concurrent hash for a small
 * self-hosted container.
 */
const ARGON2ID_PARAMS = {
  algorithm: "argon2id",
  memoryCost: 19456,
  timeCost: 2,
} as const;

/**
 * Atomically promotes `userId` to instance owner iff no owner exists yet.
 * The NOT EXISTS guard makes the UPDATE self-arbitrating: under concurrent
 * first signups (both of which passed the signup gate before either hook
 * ran), exactly one user wins. Only the winner flips allow_signup off.
 * Returns true for the winner.
 */
export function claimInstanceOwnership(db: Database, userId: string): boolean {
  const result = db.run(
    `UPDATE "user" SET role = 'owner'
     WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM "user" WHERE role = 'owner')`,
    [userId],
  );
  if (result.changes > 0) {
    setInstanceSetting(db, ALLOW_SIGNUP_KEY, "false");
    return true;
  }
  return false;
}

/**
 * Builds the better-auth instance.
 *
 * Instance roles (owner/admin/member) are modeled with the admin plugin
 * rather than the organization plugin: this is a single-org instance, so
 * `user.role` plus the admin create-user API covers the role model without
 * unused org/invitation tables or an SMTP dependency. 'owner' and 'admin'
 * are both admin-capable; new users default to 'member'.
 */
export function createAuth(deps: AuthDeps) {
  const { db, config, audit } = deps;
  return betterAuth({
    database: db,
    baseURL: config.publicUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    trustedOrigins: [config.publicUrl, ...config.additionalOrigins],
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      password: {
        hash: (password) => Bun.password.hash(password, ARGON2ID_PARAMS),
        verify: ({ hash, password }) => Bun.password.verify(password, hash),
      },
    },
    socialProviders: {
      ...(config.github === null ? {} : { github: config.github }),
      ...(config.google === null ? {} : { google: config.google }),
    },
    plugins: [
      admin({
        defaultRole: "member",
        adminRoles: ["owner", "admin"],
        roles: { owner: adminAc, admin: adminAc, member: userAc },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            // First user becomes the instance owner; further self-signup is
            // disabled (admins create users / invitations thereafter).
            claimInstanceOwnership(db, user.id);
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            await audit.appendAudit("instance", {
              action: "auth.login",
              actorType: "user",
              actorId: session.userId,
              fields: {},
            });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Runs better-auth's programmatic schema migrations (user/session/account/
 * verification + plugin columns). Idempotent. Boot order: these first, then
 * our own SQL migrations.
 */
export async function runAuthMigrations(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
