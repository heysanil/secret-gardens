import { expect, test } from "bun:test";
import { hostname } from "node:os";
import { CliError } from "./errors";
import { loopbackLogin } from "./loopback";

const HOST = "https://safe.example";

test("auth URL carries the fixed querystring contract", async () => {
  let captured = "";
  const login = loopbackLogin(HOST, {
    openUrl: () => {},
    onListening: ({ port, state, authUrl }) => {
      captured = authUrl;
      expect(authUrl).toBe(
        `${HOST}/cli-auth?redirect_port=${port}&state=${state}&name=${encodeURIComponent(hostname())}`,
      );
      // Complete the flow so the test can finish.
      void fetch(
        `http://127.0.0.1:${port}/callback?token=safe_ut_x&tokenId=ut_1&state=${state}`,
      );
    },
  });
  const result = await login;
  expect(captured).toContain("/cli-auth?");
  expect(result).toEqual({ token: "safe_ut_x", tokenId: "ut_1" });
});

test("callback with the right state resolves and serves the success page", async () => {
  let callbackBase = "";
  let state = "";
  const login = loopbackLogin(HOST, {
    openUrl: () => {},
    onListening: (info) => {
      callbackBase = `http://127.0.0.1:${info.port}/callback`;
      state = info.state;
    },
  });
  const res = await fetch(
    `${callbackBase}?token=safe_ut_tok&tokenId=ut_42&state=${state}`,
  );
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Authenticated");
  expect(await login).toEqual({ token: "safe_ut_tok", tokenId: "ut_42" });
});

test("wrong state gets a 400 and does not resolve the login", async () => {
  let callbackBase = "";
  let state = "";
  const login = loopbackLogin(HOST, {
    openUrl: () => {},
    timeoutMs: 1500,
    onListening: (info) => {
      callbackBase = `http://127.0.0.1:${info.port}/callback`;
      state = info.state;
    },
  });
  const bad = await fetch(
    `${callbackBase}?token=evil&tokenId=ut_1&state=wrong-state`,
  );
  expect(bad.status).toBe(400);
  // The flow is still pending — finish it legitimately.
  const good = await fetch(
    `${callbackBase}?token=safe_ut_ok&tokenId=ut_2&state=${state}`,
  );
  expect(good.status).toBe(200);
  expect(await login).toEqual({ token: "safe_ut_ok", tokenId: "ut_2" });
});

test("missing token/tokenId params are rejected", async () => {
  let callbackBase = "";
  let state = "";
  const login = loopbackLogin(HOST, {
    openUrl: () => {},
    onListening: (info) => {
      callbackBase = `http://127.0.0.1:${info.port}/callback`;
      state = info.state;
    },
  });
  const res = await fetch(`${callbackBase}?state=${state}`);
  expect(res.status).toBe(400);
  const good = await fetch(
    `${callbackBase}?token=safe_ut_ok&tokenId=ut_3&state=${state}`,
  );
  expect(good.status).toBe(200);
  await login;
});

test("non-callback paths are 404", async () => {
  let base = "";
  let state = "";
  const login = loopbackLogin(HOST, {
    openUrl: () => {},
    onListening: (info) => {
      base = `http://127.0.0.1:${info.port}`;
      state = info.state;
    },
  });
  const res = await fetch(`${base}/favicon.ico`);
  expect(res.status).toBe(404);
  await fetch(`${base}/callback?token=t&tokenId=i&state=${state}`);
  await login;
});

test("times out with a friendly CliError", async () => {
  const login = loopbackLogin(HOST, { openUrl: () => {}, timeoutMs: 50 });
  expect(login).rejects.toThrow(CliError);
  await login.catch((err: CliError) => {
    expect(err.message).toContain("Timed out");
    expect(err.message).toContain("--token");
  });
});
