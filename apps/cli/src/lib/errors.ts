/**
 * Expected-failure error type for the CLI. Commands throw CliError for any
 * anticipated problem (bad config, missing auth, API rejections); the command
 * wrapper prints `error.message` to stderr — never a stack trace — and exits
 * with `exitCode`.
 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/**
 * Wraps a command implementation: CliError → friendly stderr line + exit
 * code; anything else → one-line message (no stack) + exit 1. Citty's own
 * runMain would print thrown errors with their stack, so nothing expected may
 * escape this wrapper.
 */
export function wrapRun<C>(
  fn: (ctx: C) => Promise<void>,
): (ctx: C) => Promise<void> {
  return async (ctx: C) => {
    try {
      await fn(ctx);
    } catch (err) {
      if (err instanceof CliError) {
        console.error(err.message);
        process.exit(err.exitCode);
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`safe: unexpected error: ${message}`);
      process.exit(1);
    }
  };
}
