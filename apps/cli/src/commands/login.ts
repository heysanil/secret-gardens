import { createApiClient } from "@safe/api-client";
import { classifyToken } from "@safe/shared";
import { defineCommand } from "citty";
import { call } from "../lib/api";
import { discoverSafeConfig, resolveHost } from "../lib/context";
import { readCredentials, setHostCredentials } from "../lib/credentials";
import { CliError, wrapRun } from "../lib/errors";
import { defaultOpenUrl, loopbackLogin } from "../lib/loopback";

export const loginCommand = defineCommand({
  meta: {
    name: "login",
    description:
      "Authenticate with a safe server (browser flow, or --token for headless)",
  },
  args: {
    host: {
      type: "string",
      description: "Server URL, e.g. https://safe.example.com",
    },
    token: {
      type: "string",
      description:
        "Personal access token (safe_ut_…) for headless login. Caveat: flag values are visible in process listings — prefer the SAFE_TOKEN env var where that matters",
    },
  },
  run: wrapRun(async ({ args }) => {
    const env = process.env;
    const config = discoverSafeConfig(process.cwd());
    const credentials = readCredentials(env);

    let host: string;
    try {
      host = resolveHost({
        flagHost: args.host,
        config: config?.config ?? null,
        env,
        credentials,
      });
    } catch (err) {
      if (err instanceof CliError) {
        throw new CliError(
          "No host to log in to — pass --host <url> (e.g. safe login --host https://safe.example.com).",
        );
      }
      throw err;
    }

    if (args.token !== undefined) {
      // Headless path: verify the pasted token, then store it.
      if (classifyToken(args.token) === "service") {
        throw new CliError(
          "Service tokens (safe_st_…) cannot be stored with `safe login` — they are project-scoped machine tokens. Set SAFE_TOKEN=<token> in the environment instead.",
        );
      }
      const client = createApiClient({ baseUrl: host, token: args.token });
      const me = await call(host, client.api.me.get());
      setHostCredentials(host, { token: args.token }, env);
      console.log(`Logged in to ${host} as ${me.email}.`);
      return;
    }

    // Browser loopback flow (default).
    const result = await loopbackLogin(host, { openUrl: defaultOpenUrl });
    const client = createApiClient({ baseUrl: host, token: result.token });
    const me = await call(host, client.api.me.get());
    setHostCredentials(
      host,
      { token: result.token, tokenId: result.tokenId },
      env,
    );
    console.log(`Logged in to ${host} as ${me.email}.`);
  }),
});
