import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";

/**
 * CHARACTERIZATION TESTS for Elysia's response-schema runtime behavior
 * (observed on elysia 1.4.28). The route `response` maps across
 * src/routes/* rely on every cell below; if an elysia upgrade changes any
 * of them, this file fails loudly and the invariant in apps/api/AGENTS.md
 * ("Runtime response schemas…") must be re-verified and rewritten.
 *
 * The observed rules:
 *
 * 1. DECLARED statuses are runtime-validated: a mismatched body becomes a
 *    422 `{"type":"validation","on":"response",…}` error. Matching bodies
 *    keep their status (via `status()` or `set.status`).
 * 2. UNDECLARED statuses returned via `status()` keep their status code —
 *    EXCEPT when BOTH (a) the map declares only a 200 (a single-entry
 *    `{200: …}` map, or the shorthand `response: schema` which means the
 *    same) AND (b) the handler's source never references `set`: then the
 *    response is silently rewritten to HTTP 200 with the body kept.
 *    Elysia's AOT compiler inspects the handler source for `set` usage and
 *    compiles a status-blind fast path when it finds none.
 * 3. Guard/macro early-returns, thrown errors, and `onError` responses
 *    bypass response validation entirely and keep their statuses.
 *
 * None of our routes can hit the 200-rewrite today: tsc rejects
 * `status()` calls for undeclared statuses, every `set.status` write
 * targets a declared status, and the only 200-only map (bootstrap) has a
 * handler that returns nothing but the 200 shape. These tests keep the
 * footgun pinned anyway.
 */

const OK = t.Object({ ok: t.Boolean() });

interface Probe {
  status: number;
  text: string;
}

interface Handleable {
  handle(request: Request): Response | Promise<Response>;
}

async function probe(app: Handleable, url = "/r?fail=1"): Promise<Probe> {
  const res = await app.handle(new Request(`http://localhost${url}`));
  return { status: res.status, text: await res.text() };
}

/**
 * Escape hatch around Elysia's compile-time response typing: tsc forbids
 * `status()` calls for undeclared statuses (and mismatched declared
 * bodies) exactly as the AGENTS.md invariant states. These tests violate
 * that deliberately, at runtime, to pin what the runtime then does.
 */
function rawStatus(status: unknown): (code: number, body: unknown) => never {
  return status as (code: number, body: unknown) => never;
}

describe("elysia 1.4 response-schema characterization", () => {
  test("declared status with mismatched body -> 422 response-validation error", async () => {
    const app = new Elysia().get(
      "/r",
      () => ({ ok: "bad" }) as unknown as { ok: boolean },
      { response: { 200: OK } },
    );
    const res = await probe(app, "/r");
    expect(res.status).toBe(422);
    expect(res.text).toContain('"on": "response"');
  });

  test("FOOTGUN: 200-only map + handler without `set` -> undeclared status() is rewritten to HTTP 200", async () => {
    const app = new Elysia().get(
      "/r",
      ({ status, query }) => {
        if (query.fail === "1") {
          return rawStatus(status)(410, { error: "gone" });
        }
        return { ok: true };
      },
      { response: { 200: OK } },
    );
    const res = await probe(app);
    expect(res.status).toBe(200); // NOT 410 — the status is silently dropped
    expect(res.text).toBe('{"error":"gone"}'); // …but the body is kept
  });

  test("FOOTGUN: shorthand map (response: schema) behaves like the 200-only map", async () => {
    const app = new Elysia().get(
      "/r",
      ({ status, query }) => {
        if (query.fail === "1") {
          return rawStatus(status)(410, { error: "gone" });
        }
        return { ok: true };
      },
      { response: OK },
    );
    const res = await probe(app);
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"error":"gone"}');
  });

  test("200-only map + handler referencing `set` -> undeclared status() is preserved", async () => {
    const app = new Elysia().get(
      "/r",
      ({ status, set, query }) => {
        if (query.dead === "1") {
          set.status = 201; // dead branch — referencing `set` is enough
        }
        if (query.fail === "1") {
          return rawStatus(status)(410, { error: "gone" });
        }
        return { ok: true };
      },
      { response: { 200: OK } },
    );
    const res = await probe(app);
    expect(res.status).toBe(410);
    expect(res.text).toBe('{"error":"gone"}');
  });

  test("multi-status map -> undeclared status() is preserved even without `set`", async () => {
    const app = new Elysia().get(
      "/r",
      ({ status, query }) => {
        if (query.fail === "1") {
          return rawStatus(status)(410, { error: "gone" });
        }
        return { ok: true };
      },
      { response: { 200: OK, 422: t.Object({ error: t.String() }) } },
    );
    const res = await probe(app);
    expect(res.status).toBe(410);
    expect(res.text).toBe('{"error":"gone"}');
  });

  test("declared non-200 via status() keeps its code and is validated", async () => {
    const app = new Elysia().get(
      "/r",
      ({ status, query }) => {
        if (query.fail === "1") {
          return status(404, { error: "not_found" });
        }
        if (query.bad === "1") {
          return rawStatus(status)(404, { error: 123 });
        }
        return { ok: true };
      },
      {
        response: {
          200: OK,
          404: t.Object({ error: t.Literal("not_found") }),
        },
      },
    );
    const declared = await probe(app);
    expect(declared.status).toBe(404);
    expect(declared.text).toBe('{"error":"not_found"}');
    const mismatched = await probe(app, "/r?bad=1");
    expect(mismatched.status).toBe(422);
    expect(mismatched.text).toContain('"on": "response"');
  });

  test("declared non-200 via set.status keeps its code and is validated", async () => {
    const app = new Elysia().get(
      "/r",
      ({ set }) => {
        set.status = 201;
        return { made: true };
      },
      { response: { 201: t.Object({ made: t.Boolean() }) } },
    );
    const res = await probe(app, "/r");
    expect(res.status).toBe(201);
    expect(res.text).toBe('{"made":true}');
  });

  test("no response map -> status() always preserved (control)", async () => {
    const app = new Elysia().get("/r", ({ status, query }) => {
      if (query.fail === "1") {
        return status(410, { error: "gone" });
      }
      return { ok: true };
    });
    const res = await probe(app);
    expect(res.status).toBe(410);
    expect(res.text).toBe('{"error":"gone"}');
  });

  test("thrown errors bypass the response map (default 500 error path)", async () => {
    const app = new Elysia().get(
      "/r",
      ({ query }) => {
        if (query.fail === "1") {
          throw new Error("boom");
        }
        return { ok: true };
      },
      { response: { 200: OK } },
    );
    const res = await probe(app);
    expect(res.status).toBe(500);
    expect(res.text).toBe("boom");
  });

  test("macro resolve early-returns bypass response validation entirely", async () => {
    const app = new Elysia()
      .macro({
        deny: {
          resolve({ status, request }) {
            if (request.headers.get("x-deny")) {
              // Deliberately violates the declared 401 literal below.
              return status(401, { error: "invalid_token" });
            }
            return { who: "me" };
          },
        },
      })
      .get("/r", ({ who }) => ({ ok: true, who }), {
        deny: true,
        response: {
          200: t.Object({ ok: t.Boolean(), who: t.String() }),
          401: t.Object({ error: t.Literal("unauthorized") }),
        },
      });
    const res = await app.handle(
      new Request("http://localhost/r", { headers: { "x-deny": "1" } }),
    );
    expect(res.status).toBe(401); // preserved
    expect(await res.text()).toBe('{"error":"invalid_token"}'); // unvalidated
  });

  test("onError responses bypass the response map (undeclared 500 survives)", async () => {
    class Boom extends Error {}
    const app = new Elysia()
      .onError(({ error, set }) => {
        if (error instanceof Boom) {
          set.status = 500;
          return { error: "decrypt_failed" };
        }
      })
      .get(
        "/r",
        ({ query }) => {
          if (query.fail === "1") {
            throw new Boom("x");
          }
          return { ok: true };
        },
        { response: { 200: OK } },
      );
    const res = await probe(app);
    expect(res.status).toBe(500);
    expect(res.text).toBe('{"error":"decrypt_failed"}');
  });
});
