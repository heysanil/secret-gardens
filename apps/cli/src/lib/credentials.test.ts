import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialsPath,
  emptyCredentials,
  readCredentials,
  removeHostCredentials,
  setHostCredentials,
  writeCredentials,
} from "./credentials";
import { CliError } from "./errors";

// Every test gets its own fake config root — the real HOME is never touched.
const tempDirs: string[] = [];

function tempEnv(): { env: { XDG_CONFIG_HOME: string }; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gardens-cli-creds-"));
  tempDirs.push(dir);
  return { env: { XDG_CONFIG_HOME: dir }, dir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credentialsPath honors XDG_CONFIG_HOME", () => {
  expect(credentialsPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
    "/xdg/gardens/credentials.json",
  );
});

test("credentialsPath falls back to HOME/.config", () => {
  expect(credentialsPath({ HOME: "/home/me" })).toBe(
    "/home/me/.config/gardens/credentials.json",
  );
});

test("credentialsPath ignores empty XDG_CONFIG_HOME", () => {
  expect(credentialsPath({ XDG_CONFIG_HOME: "", HOME: "/home/me" })).toBe(
    "/home/me/.config/gardens/credentials.json",
  );
});

test("readCredentials returns an empty store when the file is missing", () => {
  const { env } = tempEnv();
  expect(readCredentials(env)).toEqual({ version: 1, hosts: {} });
});

test("write/read round-trip preserves the full shape", () => {
  const { env } = tempEnv();
  const creds = {
    version: 1 as const,
    defaultHost: "https://a.example",
    hosts: {
      "https://a.example": { token: "sg_ut_aaa", tokenId: "ut_1" },
      "https://b.example": { token: "sg_ut_bbb" },
    },
  };
  writeCredentials(creds, env);
  expect(readCredentials(env)).toEqual(creds);
});

test("writeCredentials creates the file with mode 0600", () => {
  const { env } = tempEnv();
  const path = writeCredentials(emptyCredentials(), env);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("writeCredentials is atomic — no .tmp file survives the write", () => {
  const { env } = tempEnv();
  const path = writeCredentials(emptyCredentials(), env);
  expect(existsSync(`${path}.tmp`)).toBe(false);
  // And again over an existing file.
  writeCredentials(emptyCredentials(), env);
  expect(existsSync(`${path}.tmp`)).toBe(false);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("writeCredentials tightens a pre-existing world-readable file to 0600", () => {
  const { env } = tempEnv();
  const path = writeCredentials(emptyCredentials(), env);
  // Loosen, then write again — chmod must bring it back to 0600.
  chmodSync(path, 0o644);
  writeCredentials(emptyCredentials(), env);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("first setHostCredentials sets defaultHost; later ones do not steal it", () => {
  const { env } = tempEnv();
  setHostCredentials("https://first.example", { token: "t1" }, env);
  setHostCredentials("https://second.example", { token: "t2" }, env);
  const creds = readCredentials(env);
  expect(creds.defaultHost).toBe("https://first.example");
  expect(Object.keys(creds.hosts).sort()).toEqual([
    "https://first.example",
    "https://second.example",
  ]);
});

test("setHostCredentials overwrites an existing host entry", () => {
  const { env } = tempEnv();
  setHostCredentials("https://a.example", { token: "old" }, env);
  setHostCredentials(
    "https://a.example",
    { token: "new", tokenId: "ut_9" },
    env,
  );
  expect(readCredentials(env).hosts["https://a.example"]).toEqual({
    token: "new",
    tokenId: "ut_9",
  });
});

test("removeHostCredentials drops the entry and clears a matching defaultHost", () => {
  const { env } = tempEnv();
  setHostCredentials("https://a.example", { token: "t1" }, env);
  setHostCredentials("https://b.example", { token: "t2" }, env);
  removeHostCredentials("https://a.example", env);
  const creds = readCredentials(env);
  expect(creds.hosts["https://a.example"]).toBeUndefined();
  expect(creds.hosts["https://b.example"]).toEqual({ token: "t2" });
  expect(creds.defaultHost).toBeUndefined();
});

test("removeHostCredentials keeps defaultHost when another host is default", () => {
  const { env } = tempEnv();
  setHostCredentials("https://a.example", { token: "t1" }, env);
  setHostCredentials("https://b.example", { token: "t2" }, env);
  removeHostCredentials("https://b.example", env);
  expect(readCredentials(env).defaultHost).toBe("https://a.example");
});

test("malformed JSON is a CliError naming the file path", () => {
  const { env } = tempEnv();
  const path = writeCredentials(emptyCredentials(), env);
  writeFileSync(path, "{ not json");
  expect(() => readCredentials(env)).toThrow(CliError);
  expect(() => readCredentials(env)).toThrow(path);
});

test("wrong shape (missing hosts) is a CliError", () => {
  const { env } = tempEnv();
  const path = writeCredentials(emptyCredentials(), env);
  writeFileSync(path, JSON.stringify({ version: 1 }));
  expect(() => readCredentials(env)).toThrow(CliError);
});

test("host entry without a token string is a CliError", () => {
  const { env } = tempEnv();
  const path = writeCredentials(emptyCredentials(), env);
  writeFileSync(
    path,
    JSON.stringify({ version: 1, hosts: { "https://a.example": {} } }),
  );
  expect(() => readCredentials(env)).toThrow(CliError);
});
