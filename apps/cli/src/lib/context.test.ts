import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SafeConfig } from "@safe/shared";
import {
  discoverSafeConfig,
  normalizeHost,
  resolveEnvSlug,
  resolveHost,
  resolveToken,
} from "./context";
import { type CredentialsFile, emptyCredentials } from "./credentials";
import { CliError } from "./errors";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "safe-cli-ctx-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CONFIG: SafeConfig = {
  host: "https://config.example",
  project: "demo",
  projectId: "prj_1",
  defaultEnvironment: "dev",
};

function credsWith(defaultHost?: string): CredentialsFile {
  const creds = emptyCredentials();
  if (defaultHost !== undefined) {
    creds.defaultHost = defaultHost;
    creds.hosts[defaultHost] = { token: "safe_ut_stored" };
  }
  return creds;
}

// --- normalizeHost ----------------------------------------------------------

test("normalizeHost strips trailing slashes", () => {
  expect(normalizeHost("https://a.example///", "--host")).toBe(
    "https://a.example",
  );
});

test("normalizeHost rejects non-URLs and non-http schemes", () => {
  expect(() => normalizeHost("not a url", "--host")).toThrow(CliError);
  expect(() => normalizeHost("ftp://a.example", "SAFE_HOST")).toThrow(
    "SAFE_HOST",
  );
});

// --- host precedence: flag > .safe.json > SAFE_HOST > defaultHost > error ---

test("host: --host flag wins over everything", () => {
  const host = resolveHost({
    flagHost: "https://flag.example",
    config: CONFIG,
    env: { SAFE_HOST: "https://env.example" },
    credentials: credsWith("https://default.example"),
  });
  expect(host).toBe("https://flag.example");
});

test("host: .safe.json beats SAFE_HOST and defaultHost", () => {
  const host = resolveHost({
    config: CONFIG,
    env: { SAFE_HOST: "https://env.example" },
    credentials: credsWith("https://default.example"),
  });
  expect(host).toBe("https://config.example");
});

test("host: SAFE_HOST beats credentials defaultHost", () => {
  const host = resolveHost({
    config: null,
    env: { SAFE_HOST: "https://env.example" },
    credentials: credsWith("https://default.example"),
  });
  expect(host).toBe("https://env.example");
});

test("host: falls back to credentials defaultHost", () => {
  const host = resolveHost({
    config: null,
    env: {},
    credentials: credsWith("https://default.example"),
  });
  expect(host).toBe("https://default.example");
});

test("host: nothing configured is a friendly error", () => {
  expect(() =>
    resolveHost({ config: null, env: {}, credentials: emptyCredentials() }),
  ).toThrow("safe login");
});

test("host: empty-string SAFE_HOST is ignored", () => {
  const host = resolveHost({
    config: null,
    env: { SAFE_HOST: "" },
    credentials: credsWith("https://default.example"),
  });
  expect(host).toBe("https://default.example");
});

// --- token precedence: SAFE_TOKEN > credentials > error ---------------------

test("token: SAFE_TOKEN wins over stored credentials", () => {
  const token = resolveToken({
    host: "https://default.example",
    env: { SAFE_TOKEN: "safe_st_env" },
    credentials: credsWith("https://default.example"),
  });
  expect(token).toBe("safe_st_env");
});

test("token: falls back to credentials for the host", () => {
  const token = resolveToken({
    host: "https://default.example",
    env: {},
    credentials: credsWith("https://default.example"),
  });
  expect(token).toBe("safe_ut_stored");
});

test("token: missing everywhere errors with the host name", () => {
  expect(() =>
    resolveToken({
      host: "https://other.example",
      env: {},
      credentials: credsWith("https://default.example"),
    }),
  ).toThrow("https://other.example");
});

test("token: empty SAFE_TOKEN is ignored", () => {
  const token = resolveToken({
    host: "https://default.example",
    env: { SAFE_TOKEN: "" },
    credentials: credsWith("https://default.example"),
  });
  expect(token).toBe("safe_ut_stored");
});

// --- env slug: -e flag > defaultEnvironment > error --------------------------

test("env: -e flag wins over the config default", () => {
  expect(resolveEnvSlug("staging", CONFIG)).toBe("staging");
});

test("env: falls back to .safe.json defaultEnvironment", () => {
  expect(resolveEnvSlug(undefined, CONFIG)).toBe("dev");
});

test("env: neither flag nor config is a friendly error", () => {
  expect(() => resolveEnvSlug(undefined, null)).toThrow("-e");
});

// --- .safe.json upward discovery ---------------------------------------------

test("discoverSafeConfig finds the file in the cwd itself", () => {
  const dir = tempDir();
  writeFileSync(join(dir, ".safe.json"), JSON.stringify(CONFIG));
  const found = discoverSafeConfig(dir);
  expect(found?.config).toEqual(CONFIG);
  expect(found?.path).toBe(join(dir, ".safe.json"));
});

test("discoverSafeConfig walks up through nested directories", () => {
  const root = tempDir();
  writeFileSync(join(root, ".safe.json"), JSON.stringify(CONFIG));
  const nested = join(root, "a", "b", "c");
  mkdirSync(nested, { recursive: true });
  const found = discoverSafeConfig(nested);
  expect(found?.path).toBe(join(root, ".safe.json"));
});

test("discoverSafeConfig prefers the nearest config", () => {
  const root = tempDir();
  writeFileSync(join(root, ".safe.json"), JSON.stringify(CONFIG));
  const nested = join(root, "inner");
  mkdirSync(nested);
  const innerConfig = { ...CONFIG, project: "inner-project" };
  writeFileSync(join(nested, ".safe.json"), JSON.stringify(innerConfig));
  expect(discoverSafeConfig(nested)?.config.project).toBe("inner-project");
});

test("discoverSafeConfig returns null when nothing is found up to the root", () => {
  // A fresh temp dir whose ancestors (os tmp, /) carry no .safe.json.
  expect(discoverSafeConfig(tempDir())).toBeNull();
});

test("discoverSafeConfig surfaces malformed JSON with the file path", () => {
  const dir = tempDir();
  const path = join(dir, ".safe.json");
  writeFileSync(path, "{ nope");
  expect(() => discoverSafeConfig(dir)).toThrow(CliError);
  expect(() => discoverSafeConfig(dir)).toThrow(path);
});

test("discoverSafeConfig surfaces schema violations with the file path", () => {
  const dir = tempDir();
  const path = join(dir, ".safe.json");
  writeFileSync(path, JSON.stringify({ host: "https://x.example" }));
  expect(() => discoverSafeConfig(dir)).toThrow(path);
  expect(() => discoverSafeConfig(dir)).toThrow("project");
});

test("a malformed config halts discovery instead of walking past it", () => {
  const root = tempDir();
  writeFileSync(join(root, ".safe.json"), JSON.stringify(CONFIG));
  const nested = join(root, "broken");
  mkdirSync(nested);
  writeFileSync(join(nested, ".safe.json"), "not json");
  // The nearer (broken) file must error — not silently fall through to root.
  expect(() => discoverSafeConfig(nested)).toThrow(CliError);
});
