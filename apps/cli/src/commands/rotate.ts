import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import { call } from "../lib/api";
import { createCommandContext, requireProjectConfig } from "../lib/context";
import { wrapRun } from "../lib/errors";

const dekCommand = defineCommand({
  meta: {
    name: "dek",
    description:
      "Rotate the project's data-encryption key and re-encrypt all secrets",
  },
  args: {
    yes: {
      type: "boolean",
      default: false,
      description: "Skip the confirmation prompt",
    },
  },
  run: wrapRun(async ({ args }) => {
    const ctx = createCommandContext();
    const { config } = requireProjectConfig(ctx);

    if (!args.yes) {
      const confirmed = await p.confirm({
        message: `Rotate the encryption key (DEK) for project "${config.project}"? Every current secret will be re-encrypted.`,
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        console.error("Cancelled.");
        process.exit(1);
      }
    }

    const result = await call(
      ctx.host,
      ctx.client.api
        .projects({ projectId: config.projectId })
        ["rotate-dek"].post(),
      { notFound: "Project not found or no access." },
    );
    console.log(
      `DEK rotated for ${config.project}: v${result.oldVersion} → v${result.newVersion} (${result.secretsRewritten} secret${
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
