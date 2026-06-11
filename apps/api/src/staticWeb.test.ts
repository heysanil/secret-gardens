import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, type TestApp } from "../test/testApp";
import { TEST_REDIS_URL } from "../test/testRedis";
import { createRedis } from "./redis/client";
import { mountWebDist } from "./staticWeb";

const redis = createRedis(TEST_REDIS_URL);

const INDEX_HTML = "<!doctype html><html><body>safe web ui</body></html>";
const ASSET_JS = 'console.log("asset");';

let distDir: string;
let ctx: TestApp;

beforeAll(async () => {
  await redis.connect();
  distDir = mkdtempSync(join(tmpdir(), "safe-webdist-"));
  writeFileSync(join(distDir, "index.html"), INDEX_HTML);
  mkdirSync(join(distDir, "assets"), { recursive: true });
  writeFileSync(join(distDir, "assets", "x.js"), ASSET_JS);
  ctx = await createTestApp(redis);
  await mountWebDist(ctx.app, distDir, ctx.auth);
});

afterAll(() => {
  ctx?.close();
  rmSync(distDir, { recursive: true, force: true });
  redis.close();
});

describe("mountWebDist", () => {
  test("GET / serves index.html", async () => {
    const res = await ctx.app.handle(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /projects/deep/link falls back to index.html (SPA routing)", async () => {
    const res = await ctx.app.handle(
      new Request("http://localhost/projects/deep/link"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /assets/x.js serves the static asset", async () => {
    const res = await ctx.app.handle(
      new Request("http://localhost/assets/x.js"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ASSET_JS);
  });

  test("unknown /api path returns the API's JSON 404, not HTML", async () => {
    const res = await ctx.app.handle(new Request("http://localhost/api/nope"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("known /api routes still take precedence over static serving", async () => {
    const res = await ctx.app.handle(
      new Request("http://localhost/api/health"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("non-GET requests to unknown paths never get index.html", async () => {
    // POST router misses are absorbed by the better-auth catch-all mount
    // (empty 404) rather than the SPA fallback — assert no HTML leaks.
    const res = await ctx.app.handle(
      new Request("http://localhost/projects/deep/link", { method: "POST" }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("safe web ui");
  });

  test("mounted better-auth GET endpoints are not shadowed by static serving", async () => {
    // Regression: a GET /* wildcard beats the ALL /* `.mount(auth.handler)`
    // for GET requests; static mode must forward these, or no browser
    // session can exist when SAFE_WEB_DIST is set.
    const res = await ctx.app.handle(
      new Request("http://localhost/api/auth/get-session"),
    );
    expect(res.status).toBe(200);
    // No cookie → better-auth answers with a JSON null session, never the
    // API's not_found shape or HTML.
    expect(await res.json()).toBeNull();
  });

  test("mounted better-auth GET endpoints carry session state through static serving", async () => {
    const email = `static-${Date.now()}@example.com`;
    const signUp = await ctx.app.handle(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password: "static-mode-password-1!",
          name: "Static Mode",
        }),
      }),
    );
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const res = await ctx.app.handle(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { email?: string } } | null;
    expect(body?.user?.email).toBe(email);
  });
});
