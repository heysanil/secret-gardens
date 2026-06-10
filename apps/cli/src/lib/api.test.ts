import { expect, test } from "bun:test";
import { call } from "./api";
import { CliError } from "./errors";

interface FakeResponse {
  data: unknown;
  error: { status: number; value: unknown } | null;
  status: number;
}

function ok(data: unknown): Promise<FakeResponse> {
  return Promise.resolve({ data, error: null, status: 200 });
}

function fail(status: number, value: unknown): Promise<FakeResponse> {
  return Promise.resolve({ data: null, error: { status, value }, status });
}

const HOST = "https://safe.example";

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return (err as CliError).message;
  }
  throw new Error("expected the call to throw");
}

test("call returns data untouched on success", async () => {
  expect(await call(HOST, ok({ hello: "world" }))).toEqual({ hello: "world" });
});

test("network failure mentions the host, not a stack trace", async () => {
  const message = await messageOf(
    call(HOST, Promise.reject(new Error("Unable to connect"))),
  );
  expect(message).toContain(HOST);
  expect(message).toContain("Unable to connect");
});

test("Eden's synthesized 503 (fetch Error as value) reads as unreachable host", async () => {
  // Eden does not reject on transport failure — it returns a 503 whose
  // error.value is the underlying fetch Error.
  const message = await messageOf(
    call(HOST, fail(503, new TypeError("fetch() failed"))),
  );
  expect(message).toContain(`Could not reach ${HOST}`);
  expect(message).toContain("fetch() failed");
});

test("401 unauthorized suggests safe login / SAFE_TOKEN", async () => {
  const message = await messageOf(
    call(HOST, fail(401, { error: "unauthorized" })),
  );
  expect(message).toContain("Not authenticated");
  expect(message).toContain("safe login");
});

test("401 invalid_token mentions expiry/revocation", async () => {
  const message = await messageOf(
    call(HOST, fail(401, { error: "invalid_token" })),
  );
  expect(message).toContain("expired or revoked");
});

test("403 is permission denied with a scope hint", async () => {
  const message = await messageOf(
    call(HOST, fail(403, { error: "forbidden" })),
  );
  expect(message).toContain("Permission denied");
  expect(message).toContain("scope");
});

test("404 uses the caller-provided context", async () => {
  const message = await messageOf(
    call(HOST, fail(404, { error: "not_found" }), {
      notFound: "Project not found or no access.",
    }),
  );
  expect(message).toBe("Project not found or no access.");
});

test("404 without context falls back to a generic message", async () => {
  const message = await messageOf(
    call(HOST, fail(404, { error: "not_found" })),
  );
  expect(message).toBe("Not found.");
});

test("422 lists offending keys (never values)", async () => {
  const message = await messageOf(
    call(HOST, fail(422, { error: "invalid_secrets", keys: ["BAD KEY", "X"] })),
  );
  expect(message).toContain("invalid_secrets");
  expect(message).toContain("BAD KEY, X");
});

test("422 lists offending environment ids", async () => {
  const message = await messageOf(
    call(
      HOST,
      fail(422, {
        error: "invalid_environment_ids",
        environmentIds: ["env_9"],
      }),
    ),
  );
  expect(message).toContain("env_9");
});

test("decrypt_failed points at SAFE_MASTER_KEY regardless of status", async () => {
  const message = await messageOf(
    call(HOST, fail(500, { error: "decrypt_failed" })),
  );
  expect(message).toContain("SAFE_MASTER_KEY");
});

test("unknown statuses degrade to a generic API error", async () => {
  const message = await messageOf(
    call(HOST, fail(503, { error: "redis_down" })),
  );
  expect(message).toContain("503");
  expect(message).toContain("redis_down");
});
