import { defineCommand } from "citty";
import {
  createCommandContext,
  fetchSecretValues,
  requireProjectConfig,
  resolveEnvironment,
  resolveEnvSlug,
} from "../lib/context";
import { CliError, wrapRun } from "../lib/errors";

/** POSIX signal numbers for the shell's 128+n exit convention. */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

export const runCommand = defineCommand({
  meta: {
    name: "run",
    description:
      "Run a command with secrets injected into its environment: gardens run [-e <env>] -- <command> [args…]",
  },
  args: {
    env: {
      type: "string",
      alias: "e",
      description:
        "Environment slug (defaults to .gardens.json defaultEnvironment)",
    },
  },
  run: wrapRun(async (cmdCtx) => {
    // Everything after the first `--` is the child command, verbatim.
    const sep = cmdCtx.rawArgs.indexOf("--");
    const childArgv = sep === -1 ? [] : cmdCtx.rawArgs.slice(sep + 1);
    if (childArgv.length === 0) {
      throw new CliError(
        "No command given — usage: gardens run [-e <env>] -- <command> [args…]",
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
    await proc.exited;
    if (proc.exitCode !== null) {
      process.exit(proc.exitCode);
    }
    // Signal death: exitCode is null and signalCode names the signal. Exit
    // 128+n per shell convention (SIGTERM → 143) rather than masking it as
    // success; unknown signal names fall back to n=1.
    process.exit(128 + (SIGNAL_NUMBERS[proc.signalCode ?? ""] ?? 1));
  }),
});
