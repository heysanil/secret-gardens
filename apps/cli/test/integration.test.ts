/**
 * CLI integration suite: real API child process (fresh SQLite + master key,
 * compose.test.yml Redis), real CLI child processes in temp dirs. Asserts
 * stdout/stderr text, exit codes, on-disk bytes, and child-process env.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeDotenv } from "@safe/shared";
import {
  type ApiServer,
  cleanupTempDirs,
  createPat,
  createProject,
  createServiceToken,
  makeWorkdir,
  runCli,
  seedOwner,
  startApi,
  tempDir,
} from "./harness";

setDefaultTimeout(30_000);

let api: ApiServer;
let ownerCookie: string;
let ownerEmail: string;
let pat: { id: string; token: string };

beforeAll(async () => {
  api = await startApi();
  const owner = await seedOwner(api.url);
  ownerCookie = owner.cookie;
  ownerEmail = owner.email;
  pat = await createPat(api.url, ownerCookie);
});

afterAll(() => {
  api?.stop();
  cleanupTempDirs();
});

describe("safe --version", () => {
  test("prints the package version", async () => {
    const res = await runCli(["--version"], {
      cwd: tempDir("safe-cli-misc-"),
      home: tempDir("safe-cli-home-"),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("0.0.1");
  });
});

describe("login / whoami / logout", () => {
  test("token login, whoami, then logout revokes and removes the entry", async () => {
    const home = tempDir("safe-cli-home-");
    const cwd = tempDir("safe-cli-misc-");
    const loginPat = await createPat(api.url, ownerCookie, "login-flow");

    // --- login --token -----------------------------------------------------
    const login = await runCli(
      ["login", "--host", api.url, "--token", loginPat.token],
      { cwd, home },
    );
    expect(login.exitCode).toBe(0);
    expect(login.stdout).toContain(`Logged in to ${api.url} as ${ownerEmail}`);

    const credsPath = join(home, ".config", "safe", "credentials.json");
    expect(statSync(credsPath).mode & 0o777).toBe(0o600);
    const creds = JSON.parse(readFileSync(credsPath, "utf8")) as {
      version: number;
      defaultHost?: string;
      hosts: Record<string, { token: string; tokenId?: string }>;
    };
    expect(creds.version).toBe(1);
    expect(creds.defaultHost).toBe(api.url);
    expect(creds.hosts[api.url]?.token).toBe(loginPat.token);

    // --- whoami (host via credentials defaultHost) ---------------------------
    const whoami = await runCli(["whoami"], { cwd, home });
    expect(whoami.exitCode).toBe(0);
    expect(whoami.stdout).toContain(ownerEmail);
    expect(whoami.stdout).toContain("owner");
    expect(whoami.stdout).toContain(api.url);

    // --- logout: token-paste login has no tokenId → prefix-match revocation --
    const logout = await runCli(["logout"], { cwd, home });
    expect(logout.exitCode).toBe(0);
    expect(logout.stdout).toContain(`Logged out of ${api.url}`);

    const after = JSON.parse(readFileSync(credsPath, "utf8")) as {
      hosts: Record<string, unknown>;
    };
    expect(after.hosts[api.url]).toBeUndefined();

    // The token must now be dead server-side.
    const me = await fetch(`${api.url}/api/me`, {
      headers: { authorization: `Bearer ${loginPat.token}` },
    });
    expect(me.status).toBe(401);
  });

  test("login rejects service tokens with a clear message", async () => {
    const project = await createProject(api.url, ownerCookie, "Login Reject");
    const serviceToken = await createServiceToken(
      api.url,
      ownerCookie,
      project.id,
      { scope: "read" },
    );
    const res = await runCli(
      ["login", "--host", api.url, "--token", serviceToken],
      { cwd: tempDir("safe-cli-misc-"), home: tempDir("safe-cli-home-") },
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Service tokens");
    expect(res.stderr).toContain("SAFE_TOKEN");
  });

  test("login with a bad token fails without storing credentials", async () => {
    const home = tempDir("safe-cli-home-");
    const res = await runCli(
      ["login", "--host", api.url, "--token", "safe_ut_bogus"],
      { cwd: tempDir("safe-cli-misc-"), home },
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("expired or revoked");
    expect(() =>
      statSync(join(home, ".config", "safe", "credentials.json")),
    ).toThrow();
  });

  test("whoami with a service SAFE_TOKEN is an informative error", async () => {
    const project = await createProject(api.url, ownerCookie, "Whoami Svc");
    const serviceToken = await createServiceToken(
      api.url,
      ownerCookie,
      project.id,
      { scope: "read" },
    );
    const res = await runCli(["whoami"], {
      cwd: makeWorkdir(api.url, project),
      home: tempDir("safe-cli-home-"),
      env: { SAFE_TOKEN: serviceToken },
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("service token");
    expect(res.stdout).toBe("");
  });
});

describe("init", () => {
  test("--project --env --yes writes exact .safe.json and appends to .gitignore", async () => {
    const project = await createProject(api.url, ownerCookie, "Init Project");
    const cwd = tempDir("safe-cli-init-");
    writeFileSync(join(cwd, ".gitignore"), "node_modules\n");

    const res = await runCli(
      [
        "init",
        "--host",
        api.url,
        "--project",
        project.slug,
        "--env",
        "staging",
        "--yes",
      ],
      { cwd, home: tempDir("safe-cli-home-"), env: { SAFE_TOKEN: pat.token } },
    );
    expect(res.exitCode).toBe(0);

    const expected = `${JSON.stringify(
      {
        host: api.url,
        project: project.slug,
        projectId: project.id,
        defaultEnvironment: "staging",
      },
      null,
      2,
    )}\n`;
    expect(readFileSync(join(cwd, ".safe.json"), "utf8")).toBe(expected);
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(
      "node_modules\n.env\n",
    );
  });

  test("creates .gitignore when missing (documented choice)", async () => {
    const project = await createProject(api.url, ownerCookie, "Init NoIgnore");
    const cwd = tempDir("safe-cli-init-");
    const res = await runCli(
      [
        "init",
        "--host",
        api.url,
        "--project",
        project.slug,
        "--env",
        "dev",
        "--yes",
      ],
      { cwd, home: tempDir("safe-cli-home-"), env: { SAFE_TOKEN: pat.token } },
    );
    expect(res.exitCode).toBe(0);
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(".env\n");
  });

  test("leaves .gitignore alone when .env is already covered", async () => {
    const project = await createProject(api.url, ownerCookie, "Init Covered");
    const cwd = tempDir("safe-cli-init-");
    writeFileSync(join(cwd, ".gitignore"), ".env\nnode_modules\n");
    const res = await runCli(
      [
        "init",
        "--host",
        api.url,
        "--project",
        project.slug,
        "--env",
        "dev",
        "--yes",
      ],
      { cwd, home: tempDir("safe-cli-home-"), env: { SAFE_TOKEN: pat.token } },
    );
    expect(res.exitCode).toBe(0);
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(
      ".env\nnode_modules\n",
    );
  });

  test("unknown project slug lists available projects", async () => {
    const res = await runCli(
      ["init", "--host", api.url, "--project", "nope", "--env", "dev", "--yes"],
      {
        cwd: tempDir("safe-cli-init-"),
        home: tempDir("safe-cli-home-"),
        env: { SAFE_TOKEN: pat.token },
      },
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Project "nope" not found');
  });

  test("unknown environment slug lists the project's environments", async () => {
    const project = await createProject(api.url, ownerCookie, "Init BadEnv");
    const res = await runCli(
      [
        "init",
        "--host",
        api.url,
        "--project",
        project.slug,
        "--env",
        "qa",
        "--yes",
      ],
      {
        cwd: tempDir("safe-cli-init-"),
        home: tempDir("safe-cli-home-"),
        env: { SAFE_TOKEN: pat.token },
      },
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("dev, staging, prod");
  });

  test("rejects service tokens (init needs a user identity)", async () => {
    const project = await createProject(api.url, ownerCookie, "Init Svc");
    const serviceToken = await createServiceToken(
      api.url,
      ownerCookie,
      project.id,
      { scope: "read_write" },
    );
    const res = await runCli(
      [
        "init",
        "--host",
        api.url,
        "--project",
        project.slug,
        "--env",
        "dev",
        "--yes",
      ],
      {
        cwd: tempDir("safe-cli-init-"),
        home: tempDir("safe-cli-home-"),
        env: { SAFE_TOKEN: serviceToken },
      },
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("user identity");
  });
});

describe("push / pull round-trip", () => {
  // Keys pre-sorted: pull writes keys in sorted order, so a fixture built
  // with sorted keys round-trips byte-identically through the dotenv codec.
  const FIXTURE_SECRETS: Record<string, string> = {
    API_KEY: "plain-value",
    EMPTY: "",
    MULTILINE: "line one\nline two\n\tindented",
    SPECIAL: `pa$$ word "quoted" 'single' # hash \\backslash`,
    TABBED: "a\tb",
  };
  const FIXTURE = serializeDotenv(FIXTURE_SECRETS);

  let cwd: string;
  let home: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    const project = await createProject(api.url, ownerCookie, "Roundtrip");
    cwd = makeWorkdir(api.url, project);
    home = tempDir("safe-cli-home-");
    env = { SAFE_TOKEN: pat.token };
  });

  test("push reports per-key change counts", async () => {
    writeFileSync(join(cwd, ".env"), FIXTURE);
    const res = await runCli(["push"], { cwd, home, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(
      "5 created, 0 updated, 0 deleted, 0 unchanged",
    );
  });

  test("pull to a file is byte-identical with the pushed fixture", async () => {
    const res = await runCli(["pull", "--out", "pulled.env"], {
      cwd,
      home,
      env,
    });
    expect(res.exitCode).toBe(0);
    expect(readFileSync(join(cwd, "pulled.env"), "utf8")).toBe(FIXTURE);
    // Count summary goes to stderr; stdout stays clean.
    expect(res.stderr).toContain("5 secrets");
    expect(res.stdout).toBe("");
    // Fresh secrets files are 0600.
    expect(statSync(join(cwd, "pulled.env")).mode & 0o777).toBe(0o600);
  });

  test("pull --out - writes the dotenv to stdout, summary to stderr", async () => {
    const res = await runCli(["pull", "--out", "-"], { cwd, home, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(FIXTURE);
    expect(res.stderr).toContain("5 secrets");
  });

  test("pull --format json emits the exact key/value record", async () => {
    const res = await runCli(["pull", "--format", "json", "--out", "-"], {
      cwd,
      home,
      env,
    });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(FIXTURE_SECRETS);
  });

  test("re-pushing the identical file is all-unchanged", async () => {
    const res = await runCli(["push"], { cwd, home, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(
      "0 created, 0 updated, 0 deleted, 5 unchanged",
    );
  });

  test("push --prune updates and deletes; pull reflects it", async () => {
    const next = { ...FIXTURE_SECRETS, API_KEY: "rotated-value" };
    delete (next as Record<string, string>).TABBED;
    writeFileSync(join(cwd, ".env"), serializeDotenv(next));
    const res = await runCli(["push", "--prune"], { cwd, home, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(
      "0 created, 1 updated, 1 deleted, 3 unchanged",
    );

    const pulled = await runCli(["pull", "--format", "json", "--out", "-"], {
      cwd,
      home,
      env,
    });
    expect(JSON.parse(pulled.stdout)).toEqual(next);
  });

  test("push with a missing file is a friendly error", async () => {
    const res = await runCli(["push", "--file", "absent.env"], {
      cwd,
      home,
      env,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("File not found: absent.env");
  });

  test("pull -e with an unknown env lists available slugs", async () => {
    const res = await runCli(["pull", "-e", "qa", "--out", "-"], {
      cwd,
      home,
      env,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Environment "qa" not found');
    expect(res.stderr).toContain("dev, staging, prod");
  });
});

describe("secrets list/get/set/rm", () => {
  let cwd: string;
  let home: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    const project = await createProject(api.url, ownerCookie, "Secrets Cmd");
    cwd = makeWorkdir(api.url, project);
    home = tempDir("safe-cli-home-");
    env = { SAFE_TOKEN: pat.token };
  });

  test("set creates, then updates", async () => {
    const created = await runCli(
      ["secrets", "set", "DB_URL", "postgres://one"],
      { cwd, home, env },
    );
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("Set DB_URL");
    expect(created.stdout).toContain("v1, created");

    const updated = await runCli(
      ["secrets", "set", "DB_URL", "postgres://two"],
      { cwd, home, env },
    );
    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain("v2, updated");
  });

  test("get prints the raw value with exactly one trailing newline", async () => {
    const res = await runCli(["secrets", "get", "DB_URL"], { cwd, home, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("postgres://two\n");
  });

  test("get of a key that never existed is a friendly error", async () => {
    const res = await runCli(["secrets", "get", "NEVER_SET"], {
      cwd,
      home,
      env,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Secret "NEVER_SET" not found');
    expect(res.stdout).toBe("");
  });

  test("list shows keys + metadata, never values", async () => {
    const res = await runCli(["secrets", "list"], { cwd, home, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("DB_URL");
    expect(res.stdout).toContain("v2");
    expect(res.stdout).not.toContain("postgres://two");
  });

  test("set with an invalid key surfaces the 422 details", async () => {
    const res = await runCli(["secrets", "set", "9BAD", "x"], {
      cwd,
      home,
      env,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("invalid_key");
  });

  test("rm deletes; get and rm afterwards are friendly errors", async () => {
    const rm = await runCli(["secrets", "rm", "DB_URL"], { cwd, home, env });
    expect(rm.exitCode).toBe(0);
    expect(rm.stdout).toContain("Deleted DB_URL");

    const get = await runCli(["secrets", "get", "DB_URL"], { cwd, home, env });
    expect(get.exitCode).toBe(1);
    expect(get.stderr).toContain('Secret "DB_URL" not found');

    const rmAgain = await runCli(["secrets", "rm", "DB_URL"], {
      cwd,
      home,
      env,
    });
    expect(rmAgain.exitCode).toBe(1);
    expect(rmAgain.stderr).toContain('Secret "DB_URL" not found');
  });
});

describe("run", () => {
  const MARKER_VALUE = "run-marker-7f3a9c";
  let cwd: string;
  let home: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    const project = await createProject(api.url, ownerCookie, "Run Cmd");
    cwd = makeWorkdir(api.url, project);
    home = tempDir("safe-cli-home-");
    env = { SAFE_TOKEN: pat.token };
    const set = await runCli(["secrets", "set", "RUN_MARKER", MARKER_VALUE], {
      cwd,
      home,
      env,
    });
    expect(set.exitCode).toBe(0);
  });

  test("injects secrets into the child environment", async () => {
    const res = await runCli(["run", "--", "env"], { cwd, home, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`RUN_MARKER=${MARKER_VALUE}`);
  });

  test("honors -e before the -- separator", async () => {
    // staging has no secrets — the marker must not leak across environments.
    const res = await runCli(["run", "-e", "staging", "--", "env"], {
      cwd,
      home,
      env,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain(`RUN_MARKER=${MARKER_VALUE}`);
  });

  test("forwards the child's exit code exactly and leaks nothing", async () => {
    const res = await runCli(["run", "--", "sh", "-c", "exit 7"], {
      cwd,
      home,
      env,
    });
    expect(res.exitCode).toBe(7);
    // The CLI's own output never contains secret values.
    expect(res.stdout).not.toContain(MARKER_VALUE);
    expect(res.stderr).not.toContain(MARKER_VALUE);
  });

  test("a signal-killed child exits 128+signal, not 0", async () => {
    const res = await runCli(["run", "--", "sh", "-c", "kill -TERM $$"], {
      cwd,
      home,
      env,
    });
    expect(res.exitCode).toBe(143); // 128 + SIGTERM(15)
  });

  test("run without -- <cmd> is a usage error", async () => {
    const res = await runCli(["run"], { cwd, home, env });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("safe run [-e <env>] -- <command>");
  });
});

describe("service tokens", () => {
  let cwd: string;
  let home: string;
  let readToken: string;
  let writeToken: string;
  let scopedToken: string;

  beforeAll(async () => {
    const project = await createProject(api.url, ownerCookie, "Service Toks");
    cwd = makeWorkdir(api.url, project);
    home = tempDir("safe-cli-home-");
    const devEnv = project.environments.find((e) => e.slug === "dev");
    if (devEnv === undefined) throw new Error("dev env missing");
    [readToken, writeToken, scopedToken] = await Promise.all([
      createServiceToken(api.url, ownerCookie, project.id, { scope: "read" }),
      createServiceToken(api.url, ownerCookie, project.id, {
        scope: "read_write",
      }),
      createServiceToken(api.url, ownerCookie, project.id, {
        scope: "read",
        environmentIds: [devEnv.id],
      }),
    ]);
    // Seed a secret as the owner.
    const set = await runCli(["secrets", "set", "SVC_KEY", "svc-value"], {
      cwd,
      home,
      env: { SAFE_TOKEN: pat.token },
    });
    expect(set.exitCode).toBe(0);
  });

  test("read-scope token can pull", async () => {
    const res = await runCli(["pull", "--out", "-"], {
      cwd,
      home,
      env: { SAFE_TOKEN: readToken },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("SVC_KEY=svc-value");
  });

  test("read-scope token cannot push (permission denied, exit 1)", async () => {
    writeFileSync(join(cwd, ".env"), "SVC_KEY=changed\n");
    const res = await runCli(["push"], {
      cwd,
      home,
      env: { SAFE_TOKEN: readToken },
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Permission denied");
  });

  test("read_write token can push", async () => {
    writeFileSync(join(cwd, ".env"), "SVC_KEY=svc-value\nNEW_KEY=added\n");
    const res = await runCli(["push"], {
      cwd,
      home,
      env: { SAFE_TOKEN: writeToken },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("1 created");
  });

  test("env-scoped token pulling an unlisted env gets the allowed list", async () => {
    const res = await runCli(["pull", "-e", "staging", "--out", "-"], {
      cwd,
      home,
      env: { SAFE_TOKEN: scopedToken },
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Environment "staging" not found');
    // The filtered project detail only lists the env the token may access.
    expect(res.stderr).toContain("available environments: dev");
    expect(res.stderr).not.toContain("staging,");
  });

  test("env-scoped token pulls its allowed env fine", async () => {
    const res = await runCli(["pull", "-e", "dev", "--out", "-"], {
      cwd,
      home,
      env: { SAFE_TOKEN: scopedToken },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("SVC_KEY=svc-value");
  });
});

describe("rotate dek", () => {
  test("--yes rotates and reports versions + rewrite count; values survive", async () => {
    const project = await createProject(api.url, ownerCookie, "Rotate Proj");
    const cwd = makeWorkdir(api.url, project);
    const home = tempDir("safe-cli-home-");
    const env = { SAFE_TOKEN: pat.token };

    writeFileSync(join(cwd, ".env"), "ROT_A=alpha\nROT_B=beta\n");
    expect((await runCli(["push"], { cwd, home, env })).exitCode).toBe(0);

    const res = await runCli(["rotate", "dek", "--yes"], { cwd, home, env });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("v1 → v2");
    expect(res.stdout).toContain("2 secrets re-encrypted");

    const pulled = await runCli(["pull", "--format", "json", "--out", "-"], {
      cwd,
      home,
      env,
    });
    expect(JSON.parse(pulled.stdout)).toEqual({
      ROT_A: "alpha",
      ROT_B: "beta",
    });
  });

  test("a service token cannot rotate", async () => {
    const project = await createProject(api.url, ownerCookie, "Rotate Svc");
    const serviceToken = await createServiceToken(
      api.url,
      ownerCookie,
      project.id,
      { scope: "read_write" },
    );
    const res = await runCli(["rotate", "dek", "--yes"], {
      cwd: makeWorkdir(api.url, project),
      home: tempDir("safe-cli-home-"),
      env: { SAFE_TOKEN: serviceToken },
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Permission denied");
  });

  test("--project <slug> works without any .safe.json", async () => {
    const project = await createProject(api.url, ownerCookie, "Rotate Flag");
    const workdir = makeWorkdir(api.url, project);
    const home = tempDir("safe-cli-home-");
    const env = { SAFE_TOKEN: pat.token };
    const set = await runCli(["secrets", "set", "FLAG_KEY", "flag-value"], {
      cwd: workdir,
      home,
      env,
    });
    expect(set.exitCode).toBe(0);

    // Bare directory: no .safe.json anywhere — host comes from SAFE_HOST.
    const res = await runCli(
      ["rotate", "dek", "--project", project.slug, "--yes"],
      {
        cwd: tempDir("safe-cli-empty-"),
        home,
        env: { ...env, SAFE_HOST: api.url },
      },
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`DEK rotated for ${project.slug}`);
    expect(res.stdout).toContain("v1 → v2");
    expect(res.stdout).toContain("1 secret re-encrypted");
  });

  test("--project with an unknown slug is a friendly error", async () => {
    const res = await runCli(["rotate", "dek", "--project", "ghost", "--yes"], {
      cwd: tempDir("safe-cli-empty-"),
      home: tempDir("safe-cli-home-"),
      env: { SAFE_TOKEN: pat.token, SAFE_HOST: api.url },
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Project "ghost" not found');
  });
});

describe("failure modes", () => {
  test("unauthenticated (no SAFE_TOKEN, no credentials) is a friendly error", async () => {
    const project = await createProject(api.url, ownerCookie, "Unauth Proj");
    const res = await runCli(["pull", "--out", "-"], {
      cwd: makeWorkdir(api.url, project),
      home: tempDir("safe-cli-home-"),
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(`Not authenticated for ${api.url}`);
    expect(res.stderr).toContain("safe login");
  });

  test("unreachable host is a friendly error, not a stack trace", async () => {
    const project = await createProject(api.url, ownerCookie, "DeadHost");
    const cwd = tempDir("safe-cli-work-");
    writeFileSync(
      join(cwd, ".safe.json"),
      `${JSON.stringify(
        {
          host: "http://127.0.0.1:9",
          project: project.slug,
          projectId: project.id,
          defaultEnvironment: "dev",
        },
        null,
        2,
      )}\n`,
    );
    const res = await runCli(["pull", "--out", "-"], {
      cwd,
      home: tempDir("safe-cli-home-"),
      env: { SAFE_TOKEN: pat.token },
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Could not reach http://127.0.0.1:9");
    expect(res.stderr).not.toContain("    at "); // no stack frames
  });

  test("missing .safe.json suggests safe init", async () => {
    const res = await runCli(["pull", "--out", "-"], {
      cwd: tempDir("safe-cli-empty-"),
      home: tempDir("safe-cli-home-"),
      env: { SAFE_TOKEN: pat.token, SAFE_HOST: api.url },
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("safe init");
  });

  test("a wrong projectId in .safe.json is 'project not found or no access'", async () => {
    const cwd = tempDir("safe-cli-work-");
    writeFileSync(
      join(cwd, ".safe.json"),
      `${JSON.stringify(
        {
          host: api.url,
          project: "ghost",
          projectId: "prj_does_not_exist",
          defaultEnvironment: "dev",
        },
        null,
        2,
      )}\n`,
    );
    const res = await runCli(["pull", "--out", "-"], {
      cwd,
      home: tempDir("safe-cli-home-"),
      env: { SAFE_TOKEN: pat.token },
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Project not found or no access");
  });
});
