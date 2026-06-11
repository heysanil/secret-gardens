import { defineCommand } from "citty";
import { call } from "../lib/api";
import {
  type CommandContext,
  createCommandContext,
  fetchSecrets,
  requireProjectConfig,
  resolveEnvironment,
  resolveEnvSlug,
} from "../lib/context";
import { wrapRun } from "../lib/errors";

const ENV_ARG = {
  type: "string",
  alias: "e",
  description:
    "Environment slug (defaults to .gardens.json defaultEnvironment)",
} as const;

interface ResolvedTarget {
  ctx: CommandContext;
  projectId: string;
  projectSlug: string;
  envId: string;
  envSlug: string;
}

async function resolveTarget(
  flagEnv: string | undefined,
): Promise<ResolvedTarget> {
  const ctx = createCommandContext();
  const { config } = requireProjectConfig(ctx);
  const envSlug = resolveEnvSlug(flagEnv, config);
  const { envId } = await resolveEnvironment(ctx, config.projectId, envSlug);
  return {
    ctx,
    projectId: config.projectId,
    projectSlug: config.project,
    envId,
    envSlug,
  };
}

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List secret keys and metadata (never values)",
  },
  args: { env: ENV_ARG },
  run: wrapRun(async ({ args }) => {
    const t = await resolveTarget(args.env);
    const entries = await fetchSecrets(t.ctx, t.projectId, t.envId, {
      includeValues: false,
    });
    if (entries.length === 0) {
      console.error(`No secrets in ${t.projectSlug}/${t.envSlug}.`);
      return;
    }
    for (const entry of [...entries].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    )) {
      console.log(
        `${entry.key}\tv${entry.version}\t${new Date(entry.updatedAt).toISOString()}`,
      );
    }
  }),
});

const getCommand = defineCommand({
  meta: {
    name: "get",
    description:
      "Print one secret's raw value to stdout (a trailing newline is appended)",
  },
  args: {
    key: { type: "positional", description: "Secret key", required: true },
    env: ENV_ARG,
  },
  run: wrapRun(async ({ args }) => {
    const t = await resolveTarget(args.env);
    // Single-key endpoint: only this secret is decrypted, and the server
    // audits one targeted secrets.read {envId, key} — not a bulk read.
    const entry = await call(
      t.ctx.host,
      t.ctx.client.api
        .projects({ projectId: t.projectId })
        .environments({ envId: t.envId })
        .secrets({ key: args.key })
        .get({ query: { include_value: "true" } }),
      {
        notFound: `Secret "${args.key}" not found in ${t.projectSlug}/${t.envSlug}.`,
      },
    );
    // The value itself, verbatim, plus a single trailing newline (documented).
    process.stdout.write(`${entry.value ?? ""}\n`);
  }),
});

const setCommand = defineCommand({
  meta: {
    name: "set",
    description: "Create or update one secret",
  },
  args: {
    key: { type: "positional", description: "Secret key", required: true },
    value: { type: "positional", description: "Secret value", required: true },
    env: ENV_ARG,
  },
  run: wrapRun(async ({ args }) => {
    const t = await resolveTarget(args.env);
    const result = await call(
      t.ctx.host,
      t.ctx.client.api
        .projects({ projectId: t.projectId })
        .environments({ envId: t.envId })
        .secrets({ key: args.key })
        .put({ value: args.value }),
      {
        notFound:
          "Project or environment not found, or your token has no access to it.",
      },
    );
    console.log(
      `Set ${result.key} in ${t.projectSlug}/${t.envSlug} (v${result.version}, ${
        result.op === "create" ? "created" : "updated"
      }).`,
    );
  }),
});

const rmCommand = defineCommand({
  meta: {
    name: "rm",
    description: "Delete one secret",
  },
  args: {
    key: { type: "positional", description: "Secret key", required: true },
    env: ENV_ARG,
  },
  run: wrapRun(async ({ args }) => {
    const t = await resolveTarget(args.env);
    const result = await call(
      t.ctx.host,
      t.ctx.client.api
        .projects({ projectId: t.projectId })
        .environments({ envId: t.envId })
        .secrets({ key: args.key })
        .delete(),
      {
        notFound: `Secret "${args.key}" not found in ${t.projectSlug}/${t.envSlug}.`,
      },
    );
    console.log(
      `Deleted ${args.key} from ${t.projectSlug}/${t.envSlug} (v${result.version}).`,
    );
  }),
});

export const secretsCommand = defineCommand({
  meta: {
    name: "secrets",
    description: "Inspect and edit individual secrets",
  },
  subCommands: {
    list: listCommand,
    get: getCommand,
    set: setCommand,
    rm: rmCommand,
  },
});
