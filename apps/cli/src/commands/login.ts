import { createApiClient } from "@secret-gardens/api-client";
import { classifyToken } from "@secret-gardens/shared";
import { defineCommand } from "citty";
import { call } from "../lib/api";
import { discoverGardensConfig, resolveHost } from "../lib/context";
import { readCredentials, setHostCredentials } from "../lib/credentials";
import { CliError, wrapRun } from "../lib/errors";
import { defaultOpenUrl, loopbackLogin } from "../lib/loopback";

export const loginCommand = defineCommand({
  meta: {
    name: "login",
    description:
      "Authenticate with a secret-gardens server (browser flow, or --token for headless)",
  },
  args: {
    host: {
      type: "string",
      description: "Server URL, e.g. https://gardens.example.com",
    },
    token: {
      type: "string",
      description:
        "Personal access token (sg_ut_…) for headless login. Caveat: flag values are visible in process listings — prefer the GARDENS_TOKEN env var where that matters",
    },
  },
  run: wrapRun(async ({ args }) => {
    const env = process.env;
    const config = discoverGardensConfig(process.cwd());
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
          "No host to log in to — pass --host <url> (e.g. gardens login --host https://gardens.example.com).",
        );
      }
      throw err;
    }

    if (args.token !== undefined) {
      // Headless path: verify the pasted token, then store it.
      if (classifyToken(args.token) === "service") {
        throw new CliError(
          "Service tokens (sg_st_…) cannot be stored with `gardens login` — they are project-scoped machine tokens. Set GARDENS_TOKEN=<token> in the environment instead.",
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
