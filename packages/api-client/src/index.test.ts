import { expect, test } from "bun:test";
import { createApiClient } from "./index";

/**
 * Stub fetcher capturing every request Eden makes. No live server: the CLI
 * integration suite covers real round-trips; here we only verify wiring
 * (headers, credentials, URL construction) and the treaty types.
 */
interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function stubFetcher(captured: CapturedRequest[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("injects Authorization: Bearer <token> when token is set", async () => {
  const captured: CapturedRequest[] = [];
  const client = createApiClient({
    baseUrl: "http://safe.test",
    token: "safe_ut_abc123",
    fetcher: stubFetcher(captured),
  });

  await client.api.health.get();

  expect(captured).toHaveLength(1);
  const headers = new Headers(captured[0]?.init.headers);
  expect(headers.get("authorization")).toBe("Bearer safe_ut_abc123");
});

test("sends no Authorization header when token is absent", async () => {
  const captured: CapturedRequest[] = [];
  const client = createApiClient({
    baseUrl: "http://safe.test",
    fetcher: stubFetcher(captured),
  });

  await client.api.health.get();

  const headers = new Headers(captured[0]?.init.headers);
  expect(headers.get("authorization")).toBeNull();
});

test("passes credentials through to fetch", async () => {
  const captured: CapturedRequest[] = [];
  const client = createApiClient({
    baseUrl: "http://safe.test",
    credentials: "include",
    fetcher: stubFetcher(captured),
  });

  await client.api.health.get();

  expect(captured[0]?.init.credentials).toBe("include");
});

test("token and credentials compose on the same request", async () => {
  const captured: CapturedRequest[] = [];
  const client = createApiClient({
    baseUrl: "http://safe.test",
    token: "safe_st_xyz789",
    credentials: "omit",
    fetcher: stubFetcher(captured),
  });

  await client.api.health.get();

  const headers = new Headers(captured[0]?.init.headers);
  expect(headers.get("authorization")).toBe("Bearer safe_st_xyz789");
  expect(captured[0]?.init.credentials).toBe("omit");
});

test("baseUrl with and without trailing slashes hits the same URL", async () => {
  const urls: string[] = [];
  for (const baseUrl of [
    "http://safe.test",
    "http://safe.test/",
    "http://safe.test///",
  ]) {
    const captured: CapturedRequest[] = [];
    const client = createApiClient({
      baseUrl,
      fetcher: stubFetcher(captured),
    });
    await client.api.health.get();
    urls.push(captured[0]?.url ?? "");
  }
  expect(urls).toEqual([
    "http://safe.test/api/health",
    "http://safe.test/api/health",
    "http://safe.test/api/health",
  ]);
});

test("Eden's { data, error, status } shape passes through untouched", async () => {
  const captured: CapturedRequest[] = [];
  const client = createApiClient({
    baseUrl: "http://safe.test",
    fetcher: stubFetcher(captured),
  });

  const res = await client.api.health.get();

  expect(res.status).toBe(200);
  expect(res.error).toBeNull();
  expect(res.data?.status).toBe("ok");
});

/**
 * Compile-time guards (enforced by `tsc --noEmit`, mirroring apps/api's
 * app.test.ts): the treaty client must keep the full route tree typed. If
 * any plugin in createApp loses its typing, these widen to `any` and the
 * `IsAny` consts below stop type-checking.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;

test("treaty client stays fully typed (no any-widening)", () => {
  const client = createApiClient({ baseUrl: "http://safe.test" });

  // Route accessors exist — referencing them is itself a tsc-level check.
  const projectsGet = client.api.projects.get;
  const secretsGet = client.api
    .projects({ projectId: "prj_1" })
    .environments({ envId: "env_1" }).secrets.get;
  const meTokensPost = client.api.me.tokens.post;

  type ProjectsData = Awaited<ReturnType<typeof projectsGet>>["data"];
  type SecretsData = Awaited<ReturnType<typeof secretsGet>>["data"];
  type MeTokensData = Awaited<ReturnType<typeof meTokensPost>>["data"];

  const clientIsAny: IsAny<typeof client> = false;
  const projectsDataIsAny: IsAny<ProjectsData> = false;
  const secretsDataIsAny: IsAny<SecretsData> = false;
  const meTokensDataIsAny: IsAny<MeTokensData> = false;

  // Structural spot-checks: success payloads keep their concrete shapes.
  const projectsHaveSlug: Extract<
    ProjectsData,
    readonly unknown[]
  >[number] extends {
    slug: string;
  }
    ? true
    : false = true;
  const mintedTokenIsPlaintext: NonNullable<MeTokensData> extends {
    token: string;
  }
    ? true
    : false = true;

  expect(clientIsAny).toBe(false);
  expect(projectsDataIsAny).toBe(false);
  expect(secretsDataIsAny).toBe(false);
  expect(meTokensDataIsAny).toBe(false);
  expect(projectsHaveSlug).toBe(true);
  expect(mintedTokenIsPlaintext).toBe(true);
});
