import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, type TestApp } from "../test/testApp";
import { TEST_REDIS_URL } from "../test/testRedis";
import { ALLOW_SIGNUP_KEY, setInstanceSetting } from "./db/instance";
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

  test("forwarded auth GETs pass response headers through (Set-Cookie)", async () => {
    // The first-user hook (earlier test) closed self-signup — reopen it
    // for this test's throwaway account.
    setInstanceSetting(ctx.db, ALLOW_SIGNUP_KEY, "true");
    const signUp = await ctx.app.handle(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `cookie-${Date.now()}@example.com`,
          password: "static-mode-password-1!",
          name: "Cookie Header",
        }),
      }),
    );
    const rawCookie = signUp.headers
      .getSetCookie()
      .find((c) => c.startsWith("better-auth.session_token="));
    expect(rawCookie).toBeDefined();
    const cookie = (rawCookie as string).split(";")[0] as string;
    // Cookie value is `<token>.<signature>`; the session row stores the
    // raw token, which lets us age exactly this session below.
    const token = decodeURIComponent(cookie.split("=")[1] as string).split(
      ".",
    )[0] as string;

    // Fresh session: better-auth does not rotate the cookie — no
    // Set-Cookie on the forwarded GET.
    const fresh = await ctx.app.handle(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie },
      }),
    );
    expect(fresh.status).toBe(200);
    expect(fresh.headers.getSetCookie()).toHaveLength(0);

    // Age the session into better-auth's refresh window: the next
    // get-session re-issues the session cookie. If the fallback rebuilt
    // the response and dropped headers, this Set-Cookie would vanish —
    // exactly the regression this guards against.
    ctx.db.run("UPDATE session SET expiresAt = ? WHERE token = ?", [
      new Date(Date.now() + 60_000).toISOString(),
      token,
    ]);
    const refreshed = await ctx.app.handle(
      new Request("http://localhost/api/auth/get-session", {
        headers: { cookie },
      }),
    );
    expect(refreshed.status).toBe(200);
    const reissued = refreshed.headers.getSetCookie();
    expect(
      reissued.some((c) => c.startsWith("better-auth.session_token=")),
    ).toBe(true);
  });

  test("HEAD requests route through the GET fallback", async () => {
    // Elysia maps HEAD onto GET handlers: the SPA fallback answers HEAD
    // with the html headers and an empty body…
    const spa = await ctx.app.handle(
      new Request("http://localhost/projects/deep/link", { method: "HEAD" }),
    );
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toContain("text/html");
    expect(await spa.text()).toBe("");

    // …and HEAD /api/auth/get-session reaches the forwarded auth handler.
    // better-auth does not serve HEAD (the bare mount 404s it identically
    // without static mode); the fallback translates that to the API's
    // JSON 404 shape, with an empty body per HEAD semantics.
    const head = await ctx.app.handle(
      new Request("http://localhost/api/auth/get-session", { method: "HEAD" }),
    );
    expect(head.status).toBe(404);
    expect(head.headers.get("content-type")).toContain("application/json");
    expect(await head.text()).toBe("");
  });
});
