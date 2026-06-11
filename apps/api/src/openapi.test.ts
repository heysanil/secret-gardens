import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, type TestApp } from "../test/testApp";
import { TEST_REDIS_URL } from "../test/testRedis";
import { API_VERSION } from "./openapi";
import { createRedis } from "./redis/client";

const redis = createRedis(TEST_REDIS_URL);

let ctx: TestApp;

beforeAll(async () => {
  await redis.connect();
  ctx = await createTestApp(redis);
});

afterAll(() => {
  ctx?.close();
  redis.close();
});

interface OperationObject {
  summary?: string;
  description?: string;
  tags?: string[];
  security?: unknown[];
  responses?: Record<string, unknown>;
}

interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  tags?: { name: string }[];
  security?: unknown[];
  components?: { securitySchemes?: Record<string, unknown> };
  paths: Record<string, Record<string, OperationObject>>;
}

async function fetchSpec(): Promise<OpenApiSpec> {
  const res = await ctx.app.handle(new Request("http://localhost/docs/json"));
  expect(res.status).toBe(200);
  return (await res.json()) as OpenApiSpec;
}

describe("openapi docs", () => {
  test("API_VERSION stays in sync with package.json", async () => {
    // openapi.ts hardcodes the version (a JSON import would force
    // resolveJsonModule onto every workspace that typechecks the App type);
    // this is the drift guard.
    const pkg = (await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json()) as { version: string };
    expect(API_VERSION).toBe(pkg.version);
  });

  test("GET /docs serves the Scalar UI without auth", async () => {
    const res = await ctx.app.handle(new Request("http://localhost/docs"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('id="api-reference"');
    expect(html).toContain("<title>secret-gardens API</title>");
  });

  test("GET /docs/json serves the spec without auth", async () => {
    const spec = await fetchSpec();
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.info.title).toBe("secret-gardens API");
    expect(spec.info.version).toBe(API_VERSION);
    expect(spec.info.description).toContain("envelope encryption");
    expect(spec.components?.securitySchemes).toContainKeys([
      "bearerAuth",
      "cookieAuth",
    ]);
    // Global default: any operation accepts either token kind or a session.
    expect(spec.security).toEqual([{ bearerAuth: [] }, { cookieAuth: [] }]);
  });

  test("spec contains only /api/* paths and covers every route group", async () => {
    const spec = await fetchSpec();
    const paths = Object.keys(spec.paths);
    // No leakage from the better-auth mount, the sign-in wrapper, or the
    // docs routes themselves.
    for (const path of paths) {
      expect(path).toStartWith("/api/");
      expect(path).not.toStartWith("/api/auth");
    }
    for (const expected of [
      "/api/health",
      "/api/bootstrap",
      "/api/me",
      "/api/me/tokens",
      "/api/users",
      "/api/projects",
      "/api/projects/{projectId}",
      "/api/projects/{projectId}/rotate-dek",
      "/api/projects/{projectId}/environments/{envId}",
      "/api/projects/{projectId}/members/{userId}",
      "/api/projects/{projectId}/tokens/{tokenId}",
      "/api/projects/{projectId}/environments/{envId}/secrets/{key}/versions",
      "/api/projects/{projectId}/environments/{envId}/secrets/{key}/rollback",
    ]) {
      expect(paths).toContain(expected);
    }
    expect(paths.length).toBeGreaterThanOrEqual(20);
  });

  test("every operation has summary, description, tags, and responses", async () => {
    // The documentation contract (apps/api/AGENTS.md): every route MUST
    // ship `detail` metadata. This fails the moment a route is added
    // without it.
    const spec = await fetchSpec();
    const knownTags = new Set((spec.tags ?? []).map((tag) => tag.name));
    let operations = 0;
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        operations += 1;
        const at = `${method.toUpperCase()} ${path}`;
        expect(op.summary, `${at} is missing detail.summary`).toBeString();
        expect(
          (op.description ?? "").length,
          `${at} is missing detail.description`,
        ).toBeGreaterThan(40);
        expect(op.tags, `${at} is missing detail.tags`).toBeArray();
        expect(op.tags?.length).toBeGreaterThan(0);
        for (const tag of op.tags ?? []) {
          expect(
            knownTags.has(tag),
            `${at} uses undeclared tag ${tag}`,
          ).toBeTrue();
        }
        expect(op.responses, `${at} has no responses`).toBeDefined();
      }
    }
    expect(operations).toBeGreaterThan(25);
  });

  test("public routes opt out of the global security requirement", async () => {
    const spec = await fetchSpec();
    expect(spec.paths["/api/health"]?.get?.security).toEqual([]);
    expect(spec.paths["/api/bootstrap"]?.get?.security).toEqual([]);
    // Spot-check an authenticated route: no override → global default.
    expect(spec.paths["/api/me"]?.get?.security).toBeUndefined();
  });
});
