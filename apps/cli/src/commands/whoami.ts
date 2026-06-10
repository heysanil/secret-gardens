import { classifyToken } from "@safe/shared";
import { defineCommand } from "citty";
import { call } from "../lib/api";
import { createCommandContext } from "../lib/context";
import { CliError, wrapRun } from "../lib/errors";

export const whoamiCommand = defineCommand({
  meta: {
    name: "whoami",
    description: "Show the authenticated user and host",
  },
  run: wrapRun(async () => {
    const ctx = createCommandContext();
    // Service tokens have no user identity; keep this an error rather than a
    // soft success so scripts can rely on whoami meaning "a user".
    if (classifyToken(ctx.token) === "service") {
      throw new CliError(
        "SAFE_TOKEN is a service token — service tokens are project-scoped machine tokens with no user identity. Unset SAFE_TOKEN or run `safe login` to act as a user.",
      );
    }
    const me = await call(ctx.host, ctx.client.api.me.get());
    console.log(`Email: ${me.email}`);
    console.log(`Name:  ${me.name}`);
    console.log(`Role:  ${me.instanceRole}`);
    console.log(`Host:  ${ctx.host}`);
  }),
});
