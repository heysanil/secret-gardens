#!/usr/bin/env bun
/**
 * safe CLI — Bearer-only client for the safe API. Commands are thin: all
 * host/token/env resolution lives in src/lib/context.ts.
 */
import { defineCommand, runMain } from "citty";
import pkg from "../package.json";
import { initCommand } from "./commands/init";
import { loginCommand } from "./commands/login";
import { logoutCommand } from "./commands/logout";
import { pullCommand } from "./commands/pull";
import { pushCommand } from "./commands/push";
import { rotateCommand } from "./commands/rotate";
import { runCommand } from "./commands/run";
import { secretsCommand } from "./commands/secrets";
import { whoamiCommand } from "./commands/whoami";

export const main = defineCommand({
  meta: {
    name: "safe",
    version: pkg.version,
    description: "safe — self-hosted secrets manager",
  },
  subCommands: {
    login: loginCommand,
    logout: logoutCommand,
    whoami: whoamiCommand,
    init: initCommand,
    pull: pullCommand,
    push: pushCommand,
    run: runCommand,
    secrets: secretsCommand,
    rotate: rotateCommand,
  },
});

if (import.meta.main) {
  await runMain(main);
}
