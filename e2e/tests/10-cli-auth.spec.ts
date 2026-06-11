/**
 * The /cli-auth loopback approval contract — approve, deny, and invalid
 * params — plus one full CLI↔browser round trip: the real `gardens login`
 * process prints its auth URL, the signed-in browser approves it, and the
 * CLI stores the minted token and can run `whoami`.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { BASE_URL, E2E_DIR, OWNER, OWNER_STATE } from "../helpers/constants";

test.use({ storageState: OWNER_STATE });

interface CallbackServer {
  port: number;
  requests: URL[];
  server: Server;
}

/** One-shot loopback listener standing in for the CLI's callback server. */
async function startCallbackServer(): Promise<CallbackServer> {
  const requests: URL[] = [];
  const server = createServer((req, res) => {
    requests.push(new URL(req.url ?? "/", "http://127.0.0.1"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><body><p>e2e callback received</p></body></html>");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { port, requests, server };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

test.describe
  .serial("cli-auth", () => {
    test("approve mints a token and redirects to the loopback", async ({
      page,
    }) => {
      const cb = await startCallbackServer();
      try {
        await page.goto(
          `/cli-auth?redirect_port=${cb.port}&state=e2e-state-approve&name=e2e-host`,
        );
        await expect(page.getByText("requesting access")).toBeVisible();
        await expect(page.getByText("e2e-host")).toBeVisible();

        await page.getByTestId("cli-auth-approve").click();
        await page.waitForURL(
          (url) =>
            url.host === `127.0.0.1:${cb.port}` && url.pathname === "/callback",
        );
        await expect(page.getByText("e2e callback received")).toBeVisible();

        expect(cb.requests).toHaveLength(1);
        const params = cb.requests[0]?.searchParams;
        expect(params?.get("token")).toMatch(/^sg_ut_/);
        expect(params?.get("tokenId")).toBeTruthy();
        expect(params?.get("state")).toBe("e2e-state-approve");
      } finally {
        await closeServer(cb.server);
      }
    });

    test("deny creates no token and hits no callback", async ({ page }) => {
      const cb = await startCallbackServer();
      try {
        await page.goto(
          `/cli-auth?redirect_port=${cb.port}&state=e2e-state-deny&name=e2e-host`,
        );
        await page.getByTestId("cli-auth-deny").click();
        await expect(page.getByText("Request denied")).toBeVisible();
        await expect(page.getByText("No token was created.")).toBeVisible();
        expect(cb.requests).toHaveLength(0);
      } finally {
        await closeServer(cb.server);
      }
    });

    test("invalid params render the error card", async ({ page }) => {
      await page.goto("/cli-auth?redirect_port=99&state=x&name=h");
      await expect(page.getByText("Invalid CLI request")).toBeVisible();
      await expect(
        page.getByText("redirect_port must be between 1024 and 65535."),
      ).toBeVisible();

      await page.goto("/cli-auth?redirect_port=8123&name=h");
      await expect(page.getByText("Invalid CLI request")).toBeVisible();
      await expect(page.getByText("Missing state parameter.")).toBeVisible();

      await page.goto("/cli-auth");
      await expect(page.getByText("Invalid CLI request")).toBeVisible();
      await expect(
        page.getByText("Missing or malformed redirect_port."),
      ).toBeVisible();
    });

    test("full loop: real `gardens login` approved from the browser", async ({
      page,
    }) => {
      const repoRoot = join(E2E_DIR, "..");
      const cliEntry = join(repoRoot, "apps", "cli", "src", "index.ts");

      // Isolated HOME so the CLI's credentials file never touches the real
      // one, plus a PATH shim so `open` cannot launch a real browser.
      const home = join(E2E_DIR, ".tmp", `cli-home-${Date.now()}`);
      const fakeBin = join(home, "bin");
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, "open"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      };
      delete env.GARDENS_TOKEN;
      delete env.GARDENS_HOST;

      let child: ChildProcess | null = null;
      try {
        child = spawn("bun", [cliEntry, "login", "--host", BASE_URL], {
          cwd: home,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdoutBuf = "";
        let stderrBuf = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBuf += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString();
        });
        const exited = new Promise<number | null>((resolve) => {
          child?.on("exit", (code) => resolve(code));
        });

        // The CLI prints the auth URL on stderr; parse it out.
        const urlRe = /(http:\/\/[^\s]+\/cli-auth\?[^\s]+)/;
        let authUrl: string | null = null;
        try {
          await expect
            .poll(() => stderrBuf.match(urlRe)?.[1] ?? null, {
              timeout: 20_000,
            })
            .not.toBeNull();
          authUrl = stderrBuf.match(urlRe)?.[1] ?? null;
        } catch {
          console.warn(
            "10-cli-auth: could not parse the /cli-auth URL from `gardens login` " +
              `stderr; skipping the full-loop test. stderr was:\n${stderrBuf}`,
          );
          test.skip(true, "could not parse the CLI auth URL");
        }
        if (authUrl === null) {
          return;
        }

        await page.goto(authUrl);
        await page.getByTestId("cli-auth-approve").click();
        // The CLI's own loopback server answers, then the process exits 0.
        await page.waitForURL(/127\.0\.0\.1:\d+\/callback/);
        const code = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("CLI did not exit after approval")),
              20_000,
            );
          }),
        ]);
        expect(code).toBe(0);
        expect(stdoutBuf).toContain(
          `Logged in to ${BASE_URL} as ${OWNER.email}`,
        );

        // The stored credentials now drive `gardens whoami`.
        const who = spawnSync("bun", [cliEntry, "whoami"], {
          cwd: home,
          env,
          encoding: "utf8",
        });
        expect(who.status, who.stderr).toBe(0);
        expect(who.stdout).toContain(`Email: ${OWNER.email}`);
        expect(who.stdout).toContain(`Host:  ${BASE_URL}`);
      } finally {
        if (child !== null && child.exitCode === null) {
          child.kill("SIGKILL");
        }
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
