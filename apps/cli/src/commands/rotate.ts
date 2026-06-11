import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import { call } from "../lib/api";
import {
  type CommandContext,
  createCommandContext,
  requireProjectConfig,
} from "../lib/context";
import { CliError, wrapRun } from "../lib/errors";

/**
 * Target project: --project <slug> resolves via the project list (no
 * .safe.json needed); otherwise .safe.json supplies it as usual.
 */
async function resolveRotateTarget(
  ctx: CommandContext,
  flagProject: string | undefined,
): Promise<{ projectId: string; projectSlug: string }> {
  if (flagProject !== undefined && flagProject !== "") {
    const projects = await call(ctx.host, ctx.client.api.projects.get());
    const found = projects.find((pr) => pr.slug === flagProject);
    if (found === undefined) {
      const available = projects.map((pr) => pr.slug).join(", ");
      throw new CliError(
        `Project "${flagProject}" not found on ${ctx.host}${
          available === "" ? "" : ` — available projects: ${available}`
        }.`,
      );
    }
    return { projectId: found.id, projectSlug: found.slug };
  }
  const { config } = requireProjectConfig(ctx);
  return { projectId: config.projectId, projectSlug: config.project };
}

const dekCommand = defineCommand({
  meta: {
    name: "dek",
    description:
      "Rotate the project's data-encryption key and re-encrypt all secrets",
  },
  args: {
    project: {
      type: "string",
      description: "Project slug (defaults to the .safe.json project)",
    },
    yes: {
      type: "boolean",
      default: false,
      description: "Skip the confirmation prompt",
    },
  },
  run: wrapRun(async ({ args }) => {
    const ctx = createCommandContext();
    const { projectId, projectSlug } = await resolveRotateTarget(
      ctx,
      args.project,
    );

    if (!args.yes) {
      const confirmed = await p.confirm({
        message: `Rotate the encryption key (DEK) for project "${projectSlug}"? Every current secret will be re-encrypted.`,
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        console.error("Cancelled.");
        process.exit(1);
      }
    }

    const result = await call(
      ctx.host,
      ctx.client.api.projects({ projectId })["rotate-dek"].post(),
      { notFound: "Project not found or no access." },
    );
    console.log(
      `DEK rotated for ${projectSlug}: v${result.oldVersion} → v${result.newVersion} (${result.secretsRewritten} secret${
        result.secretsRewritten === 1 ? "" : "s"
      } re-encrypted).`,
    );
  }),
});

export const rotateCommand = defineCommand({
  meta: {
    name: "rotate",
    description: "Key-rotation operations",
  },
  subCommands: {
    dek: dekCommand,
  },
});
