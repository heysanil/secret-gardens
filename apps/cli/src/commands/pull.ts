import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { serializeDotenv } from "@secret-gardens/shared";
import { defineCommand } from "citty";
import {
  createCommandContext,
  fetchSecretValues,
  requireProjectConfig,
  resolveEnvironment,
  resolveEnvSlug,
} from "../lib/context";
import { wrapRun } from "../lib/errors";

/** Deterministic output: keys sorted bytewise so pulls diff/round-trip cleanly. */
function sortedRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = record[key] as string;
  }
  return out;
}

export const pullCommand = defineCommand({
  meta: {
    name: "pull",
    description:
      "Download secrets to a dotenv (or JSON) file; `--out -` writes to stdout",
  },
  args: {
    env: {
      type: "string",
      alias: "e",
      description:
        "Environment slug (defaults to .gardens.json defaultEnvironment)",
    },
    out: {
      type: "string",
      default: ".env",
      description: 'Output path, or "-" for stdout',
    },
    format: {
      type: "enum",
      options: ["dotenv", "json"],
      default: "dotenv",
      description: "Output format",
    },
  },
  run: wrapRun(async ({ args }) => {
    const ctx = createCommandContext();
    const { config } = requireProjectConfig(ctx);
    const envSlug = resolveEnvSlug(args.env, config);
    const { envId } = await resolveEnvironment(ctx, config.projectId, envSlug);

    const secrets = sortedRecord(
      await fetchSecretValues(ctx, config.projectId, envId),
    );
    const count = Object.keys(secrets).length;
    const body =
      args.format === "json"
        ? `${JSON.stringify(secrets, null, 2)}\n`
        : serializeDotenv(secrets);

    if (args.out === "-") {
      process.stdout.write(body);
    } else {
      // 0600 on creation — it's a secrets file (existing files keep their mode).
      writeFileSync(resolve(process.cwd(), args.out), body, { mode: 0o600 });
    }

    // Summary on stderr: stdout may be carrying the secrets themselves.
    const destination = args.out === "-" ? "stdout" : args.out;
    console.error(
      `Pulled ${count} secret${count === 1 ? "" : "s"} from ${config.project}/${envSlug} to ${destination}.`,
    );
  }),
});
