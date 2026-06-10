/**
 * Integration harness: boots the REAL API (apps/api) as a child process
 * against the compose.test.yml Redis, seeds it over HTTP, and runs the CLI
 * via Bun.spawn in temp dirs — never the real HOME.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { TEST_REDIS_URL } from "./testRedis";

const API_ENTRY = resolve(import.meta.dir, "../../api/src/index.ts");
const CLI_ENTRY = resolve(import.meta.dir, "../src/index.ts");

export interface ApiServer {
  url: string;
  stop(): void;
}

const cleanupDirs: string[] = [];

/** mkdtemp under the OS tmpdir, removed by `cleanupTempDirs()`. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port as number;
  server.stop(true);
  return port;
}

/** Boots apps/api with a fresh master key / SQLite file on a random port. */
export async function startApi(): Promise<ApiServer> {
  const port = await freePort();
  const dataDir = tempDir("safe-cli-api-");
  const proc: Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    [process.execPath, API_ENTRY],
    {
      env: {
        ...process.env,
        PORT: String(port),
        SAFE_MASTER_KEY: randomBytes(32).toString("base64"),
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        REDIS_URL: TEST_REDIS_URL,
        SAFE_DB_PATH: join(dataDir, "safe.db"),
        SAFE_PUBLIC_URL: `http://127.0.0.1:${port}`,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const url = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        break;
      }
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      proc.kill();
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`API failed to start within 30s. stderr:\n${stderr}`);
    }
    await Bun.sleep(100);
  }

  return {
    url,
    stop() {
      proc.kill();
    },
  };
}

// --- HTTP seeding helpers ----------------------------------------------------

function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c): c is string => c !== undefined && c !== "")
    .join("; ");
}

async function jsonOrThrow<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${what} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** Signs up the instance owner (first signup) and returns their cookie. */
export async function seedOwner(
  api: string,
): Promise<{ cookie: string; email: string }> {
  const email = `owner-${crypto.randomUUID()}@cli.test`;
  const res = await fetch(`${api}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123", name: "CLI Owner" }),
  });
  await jsonOrThrow(res, "owner signup");
  return { cookie: cookieOf(res), email };
}

/** Mints a personal access token via the cookie session. */
export async function createPat(
  api: string,
  cookie: string,
  name = "cli-test",
): Promise<{ id: string; token: string }> {
  const res = await fetch(`${api}/api/me/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name }),
  });
  return jsonOrThrow(res, "PAT creation");
}

export interface SeededProject {
  id: string;
  slug: string;
  environments: { id: string; name: string; slug: string }[];
}

export async function createProject(
  api: string,
  cookie: string,
  name: string,
): Promise<SeededProject> {
  const res = await fetch(`${api}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name }),
  });
  return jsonOrThrow(res, "project creation");
}

export async function createServiceToken(
  api: string,
  cookie: string,
  projectId: string,
  opts: { scope: "read" | "read_write"; environmentIds?: string[] },
): Promise<string> {
  const res = await fetch(`${api}/api/projects/${projectId}/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: `st-${opts.scope}`, ...opts }),
  });
  const body = await jsonOrThrow<{ token: string }>(res, "service token");
  return body.token;
}

// --- CLI runner ---------------------------------------------------------------

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  cwd: string;
  /** Fake HOME — credentials land in `${home}/.config/safe/`. */
  home: string;
  env?: Record<string, string>;
}

/**
 * Runs the CLI as a real child process with a minimal environment: only
 * PATH/TMPDIR pass through, HOME is the per-test fake, SAFE_* only when the
 * test sets them.
 */
export async function runCli(
  args: string[],
  opts: RunCliOptions,
): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd: opts.cwd,
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      HOME: opts.home,
      ...opts.env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Creates a project work dir containing a valid .safe.json. */
export function makeWorkdir(
  host: string,
  project: SeededProject,
  defaultEnvironment = "dev",
): string {
  const dir = tempDir("safe-cli-work-");
  writeFileSync(
    join(dir, ".safe.json"),
    `${JSON.stringify(
      {
        host,
        project: project.slug,
        projectId: project.id,
        defaultEnvironment,
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}
