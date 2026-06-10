import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { Elysia } from "elysia";
import type { Auth } from "./auth";
import type { Config } from "./config";
import {
  ALLOW_SIGNUP_KEY,
  countUsers,
  getInstanceSetting,
} from "./db/instance";
import type { AuditLog } from "./redis/audit";
import type { RedisLike } from "./redis/client";
import { bootstrapRoutes } from "./routes/bootstrap";
import { healthRoutes } from "./routes/health";
import { meRoutes } from "./routes/me";
import { usersRoutes } from "./routes/users";

export interface AppDeps {
  db: Database;
  redis: RedisLike;
  config: Config;
  auth: Auth;
  audit: AuditLog;
}

const SIGN_UP_PATH = "/api/auth/sign-up/email";
const SIGN_IN_PATH = "/api/auth/sign-in/email";

/**
 * Best-effort `auth.failed_login` audit entry. `bodySource` is a clone of
 * the sign-in request taken before better-auth consumed the body.
 */
async function appendFailedLogin(
  audit: AuditLog,
  bodySource: Request,
  server: Server<unknown> | null,
): Promise<void> {
  const fields: Record<string, string> = {};
  try {
    const body: unknown = await bodySource.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "email" in body &&
      typeof body.email === "string"
    ) {
      fields.email = body.email;
    }
  } catch {
    // Unparseable body — log without an email.
  }
  const forwarded = bodySource.headers.get("x-forwarded-for");
  fields.ip =
    forwarded?.split(",")[0]?.trim() ||
    server?.requestIP(bodySource)?.address ||
    "unknown";
  try {
    await audit.appendAudit("instance", {
      action: "auth.failed_login",
      actorType: "system",
      actorId: "anonymous",
      fields,
    });
  } catch (err) {
    console.error("failed to append auth.failed_login audit entry:", err);
  }
}

/**
 * Composition root. Side-effect-free: no listening, no env reads — boot
 * wiring lives in index.ts so this stays importable for tests and for Eden
 * type extraction.
 */
export function createApp(deps: AppDeps) {
  const { db, auth, audit } = deps;
  return (
    new Elysia()
      // Signup gate: once a first user exists and allow_signup has been
      // flipped off, self-signup is closed (admins create users instead).
      // With zero users, signup is always allowed (bootstrap state).
      .onRequest(({ request, set }) => {
        if (request.method !== "POST") return;
        if (new URL(request.url).pathname !== SIGN_UP_PATH) return;
        if (
          getInstanceSetting(db, ALLOW_SIGNUP_KEY) === "false" &&
          countUsers(db) > 0
        ) {
          set.status = 403;
          return { error: "signup_disabled" };
        }
      })
      // Explicit sign-in wrapper (shadows the mount below): audits failed
      // logins, which a post-mount hook cannot observe reliably.
      .post(SIGN_IN_PATH, async ({ request, server }) => {
        // Elysia types `request` with undici's Request; at runtime both the
        // original and the clone are Bun Requests.
        const bodySource = request.clone() as unknown as Request;
        const response = await auth.handler(
          request as unknown as Parameters<Auth["handler"]>[0],
        );
        if (response.status >= 400) {
          await appendFailedLogin(audit, bodySource, server);
        }
        return response;
      })
      .mount(auth.handler)
      .use(healthRoutes(deps))
      .use(bootstrapRoutes(deps))
      .use(meRoutes(deps))
      .use(usersRoutes(deps))
  );
}

export type App = ReturnType<typeof createApp>;
