import { createApiClient } from "@secret-gardens/api-client";
import { defineCommand } from "citty";
import { call } from "../lib/api";
import { discoverGardensConfig, resolveHost } from "../lib/context";
import { readCredentials, removeHostCredentials } from "../lib/credentials";
import { CliError, wrapRun } from "../lib/errors";

/** Token prefixes stored server-side are the first 12 chars of the token. */
const TOKEN_DISPLAY_PREFIX_LEN = 12;

export const logoutCommand = defineCommand({
  meta: {
    name: "logout",
    description: "Revoke the stored token and remove local credentials",
  },
  run: wrapRun(async () => {
    const env = process.env;
    const config = discoverGardensConfig(process.cwd());
    const credentials = readCredentials(env);
    const host = resolveHost({
      config: config?.config ?? null,
      env,
      credentials,
    });

    const entry = credentials.hosts[host];
    if (entry === undefined) {
      throw new CliError(`Not logged in to ${host}.`);
    }

    // Best-effort server-side revocation: a failure (expired token, server
    // down) must not leave stale local credentials behind.
    const client = createApiClient({ baseUrl: host, token: entry.token });
    try {
      if (entry.tokenId !== undefined) {
        await call(host, client.api.me.tokens({ id: entry.tokenId }).delete());
      } else {
        // Token-paste logins have no tokenId — find it by exact prefix match.
        const prefix = entry.token.slice(0, TOKEN_DISPLAY_PREFIX_LEN);
        const tokens = await call(host, client.api.me.tokens.get());
        const match = tokens.find(
          (t) => t.tokenPrefix === prefix && t.revokedAt === null,
        );
        if (match !== undefined) {
          await call(host, client.api.me.tokens({ id: match.id }).delete());
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `warning: could not revoke the token on ${host} (${detail}) — removing local credentials anyway.`,
      );
    }

    removeHostCredentials(host, env);
    console.log(`Logged out of ${host}.`);
  }),
});
