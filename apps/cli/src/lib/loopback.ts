/**
 * Browser-loopback login: a one-shot HTTP server on 127.0.0.1 (random port)
 * awaiting the /cli-auth web page's redirect. The querystring contract is
 * FIXED: we open `${host}/cli-auth?redirect_port=<port>&state=<state>&name=
 * <hostname>` and receive `GET /callback?token=<...>&tokenId=<...>&state=
 * <...>`.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { CliError } from "./errors";

export interface LoopbackResult {
  token: string;
  tokenId: string;
}

export interface LoopbackOptions {
  /** Opens the auth URL in a browser; injectable for tests. */
  openUrl?: (url: string) => void;
  /** Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Test hook fired once the server is listening. */
  onListening?: (info: {
    port: number;
    state: string;
    authUrl: string;
  }) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>safe</title></head>
  <body style="font-family: system-ui, sans-serif; text-align: center; padding-top: 4rem;">
    <p><strong>Authenticated</strong> — you can close this tab and return to your terminal.</p>
  </body>
</html>
`;

/** Best-effort `open`/`xdg-open`; the URL is always printed as a fallback. */
export function defaultOpenUrl(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    // No opener available — the printed URL is the fallback.
  }
}

/**
 * Runs the loopback flow against `host` and resolves with the minted token.
 * Rejects with a friendly CliError on timeout. The `state` nonce is single
 * use: replays and mismatches get a 400 and never resolve the flow.
 */
export async function loopbackLogin(
  host: string,
  opts: LoopbackOptions = {},
): Promise<LoopbackResult> {
  const state = randomBytes(16).toString("hex");
  let settled = false;
  let resolveResult!: (result: LoopbackResult) => void;
  let rejectResult!: (err: Error) => void;
  const done = new Promise<LoopbackResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") {
        return new Response("Not found", { status: 404 });
      }
      const token = url.searchParams.get("token");
      const tokenId = url.searchParams.get("tokenId");
      const gotState = url.searchParams.get("state");
      if (settled || gotState !== state || token === null || tokenId === null) {
        return new Response("Invalid or expired login attempt.", {
          status: 400,
          headers: { connection: "close" },
        });
      }
      settled = true;
      resolveResult({ token, tokenId });
      return new Response(SUCCESS_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          connection: "close",
        },
      });
    },
  });

  // `port` is only undefined for unix-socket servers; this one is TCP.
  const port = server.port as number;
  const authUrl =
    `${host}/cli-auth?redirect_port=${port}&state=${state}` +
    `&name=${encodeURIComponent(hostname())}`;
  opts.onListening?.({ port, state, authUrl });
  console.error("Opening your browser to approve this login:");
  console.error(`  ${authUrl}`);
  console.error("If it does not open, paste the URL into a browser manually.");
  (opts.openUrl ?? defaultOpenUrl)(authUrl);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectResult(
        new CliError(
          "Timed out waiting for the browser login — try again, or use `safe login --token <token>` with a personal access token.",
        ),
      );
    }
  }, timeoutMs);

  try {
    return await done;
  } finally {
    clearTimeout(timer);
    // Give the in-flight "Authenticated" response a beat to flush before
    // force-closing remaining (keep-alive) browser connections.
    await Bun.sleep(100);
    server.stop(true);
  }
}
