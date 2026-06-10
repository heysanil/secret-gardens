import { defineCommand } from "citty";
import {
  createCommandContext,
  fetchSecretValues,
  requireProjectConfig,
  resolveEnvironment,
  resolveEnvSlug,
} from "../lib/context";
import { CliError, wrapRun } from "../lib/errors";

export const runCommand = defineCommand({
  meta: {
    name: "run",
    description:
      "Run a command with secrets injected into its environment: safe run [-e <env>] -- <command> [args…]",
  },
  args: {
    env: {
      type: "string",
      alias: "e",
      description:
        "Environment slug (defaults to .safe.json defaultEnvironment)",
    },
  },
  run: wrapRun(async (cmdCtx) => {
    // Everything after the first `--` is the child command, verbatim.
    const sep = cmdCtx.rawArgs.indexOf("--");
    const childArgv = sep === -1 ? [] : cmdCtx.rawArgs.slice(sep + 1);
    if (childArgv.length === 0) {
      throw new CliError(
        "No command given — usage: safe run [-e <env>] -- <command> [args…]",
      );
    }

    const ctx = createCommandContext();
    const { config } = requireProjectConfig(ctx);
    const envSlug = resolveEnvSlug(cmdCtx.args.env, config);
    const { envId } = await resolveEnvironment(ctx, config.projectId, envSlug);
    // Values live only in this process's memory and the child's env — never
    // on disk, never on the CLI's own stdout/stderr.
    const secrets = await fetchSecretValues(ctx, config.projectId, envId);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(childArgv, {
        env: { ...process.env, ...secrets },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new CliError(`Could not start "${childArgv[0]}": ${detail}`);
    }

    // stdio is inherited and the child shares our foreground process group,
    // so SIGINT reaches it naturally; we just forward its exit code exactly.
    const code = await proc.exited;
    process.exit(code);
  }),
});
