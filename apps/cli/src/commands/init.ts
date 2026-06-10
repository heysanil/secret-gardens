import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { createApiClient } from "@safe/api-client";
import {
  classifyToken,
  SAFE_CONFIG_FILENAME,
  type SafeConfig,
} from "@safe/shared";
import { defineCommand } from "citty";
import { call } from "../lib/api";
import { discoverSafeConfig, resolveHost, resolveToken } from "../lib/context";
import { readCredentials } from "../lib/credentials";
import { CliError, wrapRun } from "../lib/errors";

interface ProjectDetail {
  id: string;
  name: string;
  slug: string;
  environments: { id: string; name: string; slug: string }[];
}

/** Unwraps a clack prompt result, treating Ctrl-C as a friendly abort. */
function must<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    throw new CliError("Cancelled.");
  }
  return value as Exclude<T, symbol>;
}

/**
 * .gitignore policy (documented decision): if .gitignore exists and lacks an
 * exact `.env` line, append one; if it does not exist, create it with just
 * `.env`. Skipped when the file already covers `.env`.
 */
function ensureEnvIgnored(cwd: string): "appended" | "created" | "already" {
  const path = join(cwd, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(path, ".env\n");
    return "created";
  }
  const content = readFileSync(path, "utf8");
  const hasEntry = content
    .split(/\r?\n/)
    .some((line) => line.trim() === ".env");
  if (hasEntry) {
    return "already";
  }
  const joiner = content === "" || content.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${content}${joiner}.env\n`);
  return "appended";
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: `Link this directory to a project by writing ${SAFE_CONFIG_FILENAME}`,
  },
  args: {
    host: {
      type: "string",
      description: "Server URL, e.g. https://safe.example.com",
    },
    project: {
      type: "string",
      description: "Existing project slug (skips the interactive picker)",
    },
    env: {
      type: "string",
      description: "Default environment slug (skips the interactive picker)",
    },
    yes: {
      type: "boolean",
      default: false,
      description: "Assume yes for confirmations (.gitignore append)",
    },
  },
  run: wrapRun(async ({ args }) => {
    const env = process.env;
    const cwd = process.cwd();
    const credentials = readCredentials(env);
    const existing = discoverSafeConfig(cwd);
    const host = resolveHost({
      flagHost: args.host,
      config: existing?.config ?? null,
      env,
      credentials,
    });
    const token = resolveToken({ host, env, credentials });
    if (classifyToken(token) === "service") {
      throw new CliError(
        "`safe init` needs a user identity — service tokens cannot list or create projects. Run `safe login` or set SAFE_TOKEN to a personal access token.",
      );
    }
    const client = createApiClient({ baseUrl: host, token });
    const interactive = args.project === undefined || args.env === undefined;

    if (interactive) {
      p.intro("safe init");
    }

    // --- Pick or create the project -------------------------------------
    const projects = await call(host, client.api.projects.get());
    let project: ProjectDetail;
    if (args.project !== undefined) {
      const found = projects.find((pr) => pr.slug === args.project);
      if (found === undefined) {
        const available = projects.map((pr) => pr.slug).join(", ");
        throw new CliError(
          `Project "${args.project}" not found on ${host}${
            available === "" ? "" : ` — available projects: ${available}`
          }.`,
        );
      }
      project = await call(
        host,
        client.api.projects({ projectId: found.id }).get(),
        { notFound: "Project not found or no access." },
      );
    } else {
      const CREATE = "__create__";
      const choice = must(
        await p.select({
          message: "Select a project",
          options: [
            ...projects.map((pr) => ({
              value: pr.id,
              label: `${pr.name} (${pr.slug})`,
            })),
            { value: CREATE, label: "Create a new project" },
          ],
        }),
      );
      if (choice === CREATE) {
        const name = must(
          await p.text({
            message: "Project name",
            validate: (value) =>
              (value ?? "").trim() === ""
                ? "Name must not be empty"
                : undefined,
          }),
        );
        // The server derives the slug from the name.
        project = await call(
          host,
          client.api.projects.post({ name: name.trim() }),
        );
        p.log.success(
          `Created project ${project.name} (slug: ${project.slug})`,
        );
      } else {
        project = await call(
          host,
          client.api.projects({ projectId: choice }).get(),
          { notFound: "Project not found or no access." },
        );
      }
    }

    // --- Pick the default environment -----------------------------------
    let envSlug: string;
    if (args.env !== undefined) {
      const found = project.environments.find((e) => e.slug === args.env);
      if (found === undefined) {
        const available = project.environments.map((e) => e.slug).join(", ");
        throw new CliError(
          `Environment "${args.env}" not found in project "${project.slug}" — available environments: ${available}.`,
        );
      }
      envSlug = found.slug;
    } else {
      envSlug = must(
        await p.select({
          message: "Default environment",
          options: project.environments.map((e) => ({
            value: e.slug,
            label: `${e.name} (${e.slug})`,
          })),
        }),
      );
    }

    // --- Write .safe.json -------------------------------------------------
    const config: SafeConfig = {
      host,
      project: project.slug,
      projectId: project.id,
      defaultEnvironment: envSlug,
    };
    writeFileSync(
      join(cwd, SAFE_CONFIG_FILENAME),
      `${JSON.stringify(config, null, 2)}\n`,
    );

    // --- Offer the .gitignore append --------------------------------------
    let ignore = args.yes;
    if (!ignore && interactive) {
      ignore = must(
        await p.confirm({
          message: "Add .env to .gitignore (recommended)?",
          initialValue: true,
        }),
      );
    }
    let ignoreNote = "";
    if (ignore) {
      const outcome = ensureEnvIgnored(cwd);
      ignoreNote =
        outcome === "already"
          ? " (.env already in .gitignore)"
          : ` (.env ${outcome === "created" ? "added to a new" : "appended to"} .gitignore)`;
    }

    const summary = `Wrote ${SAFE_CONFIG_FILENAME} — project "${project.slug}", default environment "${envSlug}"${ignoreNote}.`;
    if (interactive) {
      p.outro(summary);
    } else {
      console.log(summary);
    }
  }),
});
