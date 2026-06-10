import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDotenv } from "@safe/shared";
import { defineCommand } from "citty";
import { call } from "../lib/api";
import {
  createCommandContext,
  requireProjectConfig,
  resolveEnvironment,
  resolveEnvSlug,
} from "../lib/context";
import { CliError, wrapRun } from "../lib/errors";

export const pushCommand = defineCommand({
  meta: {
    name: "push",
    description: "Upload a dotenv file's secrets (bulk upsert)",
  },
  args: {
    env: {
      type: "string",
      alias: "e",
      description:
        "Environment slug (defaults to .safe.json defaultEnvironment)",
    },
    file: {
      type: "string",
      default: ".env",
      description: "Dotenv file to push",
    },
    prune: {
      type: "boolean",
      default: false,
      description: "Delete server secrets that are absent from the file",
    },
  },
  run: wrapRun(async ({ args }) => {
    const ctx = createCommandContext();
    const { config } = requireProjectConfig(ctx);
    const envSlug = resolveEnvSlug(args.env, config);
    const { envId } = await resolveEnvironment(ctx, config.projectId, envSlug);

    const path = resolve(process.cwd(), args.file);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CliError(`File not found: ${args.file}`);
      }
      throw err;
    }
    const secrets = parseDotenv(content);

    const result = await call(
      ctx.host,
      ctx.client.api
        .projects({ projectId: config.projectId })
        .environments({ envId })
        .secrets.put({ secrets, prune: args.prune }),
      {
        notFound:
          "Project or environment not found, or your token has no access to it.",
      },
    );

    const total = Object.keys(secrets).length;
    console.log(
      `Pushed ${total} secret${total === 1 ? "" : "s"} to ${config.project}/${envSlug}: ` +
        `${result.created.length} created, ${result.updated.length} updated, ` +
        `${result.deleted.length} deleted, ${result.unchanged} unchanged.`,
    );
  }),
});
