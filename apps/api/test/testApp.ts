/**
 * Shared integration-test harness: in-memory SQLite, real test Redis,
 * better-auth + our migrations, and the composed app — everything app.handle
 * tests need.
 */
import type { Database } from "bun:sqlite";
import { generateMasterKey } from "@safe/crypto";
import { type App, type AppDeps, createApp } from "../src/app";
import { type Auth, createAuth, runAuthMigrations } from "../src/auth";
import { type Config, loadConfig } from "../src/config";
import { openDb, runMigrations } from "../src/db";
import { type AuditLog, createAuditLog } from "../src/redis/audit";
import type { RedisLike } from "../src/redis/client";
import { TEST_REDIS_URL } from "./testRedis";

export interface TestApp {
  app: App;
  db: Database;
  auth: Auth;
  audit: AuditLog;
  config: Config;
  deps: AppDeps;
  close(): void;
}

/** Builds a fully migrated app over the given (already connected) Redis. */
export async function createTestApp(redis: RedisLike): Promise<TestApp> {
  const config = loadConfig({
    SAFE_MASTER_KEY: generateMasterKey(),
    REDIS_URL: TEST_REDIS_URL,
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  });
  const db = openDb(":memory:");
  const audit = createAuditLog(redis);
  const auth = createAuth({ db, config, audit });
  await runAuthMigrations(auth);
  runMigrations(db);
  const deps: AppDeps = { db, redis, config, auth, audit };
  const app = createApp(deps);
  return { app, db, auth, audit, config, deps, close: () => db.close() };
}

export interface Credentials {
  email: string;
  password: string;
  name?: string;
}

/** Joins all Set-Cookie pairs of a response into a Cookie header value. */
export function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c): c is string => c !== undefined && c !== "")
    .join("; ");
}

export async function signUp(
  app: App,
  { email, password, name = "Test User" }: Credentials,
): Promise<{ res: Response; cookie: string }> {
  const res = await app.handle(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    }),
  );
  return { res, cookie: cookieHeader(res) };
}

export async function signIn(
  app: App,
  { email, password }: Credentials,
): Promise<{ res: Response; cookie: string }> {
  const res = await app.handle(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  return { res, cookie: cookieHeader(res) };
}

/** JSON request against app.handle with an optional session cookie. */
export async function api(
  app: App,
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) {
    headers.cookie = opts.cookie;
  }
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return app.handle(
    new Request(`http://localhost${path}`, { method, headers, body }),
  );
}

/** Signs up a user and returns their session cookie and user id. */
export async function signUpUser(
  app: App,
  tag: string,
): Promise<{ cookie: string; userId: string; email: string }> {
  const email = `${tag}-${crypto.randomUUID()}@test.dev`;
  const { res, cookie } = await signUp(app, { email, password: "password123" });
  const body = (await res.json()) as { user: { id: string } };
  return { cookie, userId: body.user.id, email };
}

/**
 * Creates a member-role user via the admin API and signs them in.
 * Requires an owner/admin session cookie.
 */
export async function createMemberUser(
  app: App,
  adminCookie: string,
  tag: string,
): Promise<{ cookie: string; userId: string; email: string }> {
  const email = `${tag}-${crypto.randomUUID()}@test.dev`;
  const password = "memberpass123";
  const res = await adminCreateUser(app, adminCookie, { email, password });
  const created = (await res.json()) as { user: { id: string } };
  const { cookie } = await signIn(app, { email, password });
  return { cookie, userId: created.user.id, email };
}

/** Creates a 'member'-role user via the better-auth admin API. */
export async function adminCreateUser(
  app: App,
  adminCookie: string,
  { email, password, name = "Member User" }: Credentials,
): Promise<Response> {
  return app.handle(
    new Request("http://localhost/api/auth/admin/create-user", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ email, password, name }),
    }),
  );
}
