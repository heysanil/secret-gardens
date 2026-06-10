/**
 * /cli-auth contract helpers. THE CONTRACT IS FIXED — the CLI is built
 * against it:
 *
 *   web reads   ?redirect_port=<1024-65535>&state=<non-empty>&name=<host>
 *   on approve  http://127.0.0.1:<port>/callback?token=<t>&tokenId=<id>&state=<s>
 */

export interface CliAuthRequest {
  port: number;
  state: string;
  /** Hostname the CLI reported; display-only. */
  name: string;
}

export type CliAuthParse =
  | { ok: true; request: CliAuthRequest }
  | { ok: false; error: string };

const PORT_RE = /^\d+$/;

export function parseCliAuthParams(params: URLSearchParams): CliAuthParse {
  const rawPort = params.get("redirect_port") ?? "";
  if (!PORT_RE.test(rawPort)) {
    return { ok: false, error: "Missing or malformed redirect_port." };
  }
  const port = Number(rawPort);
  if (port < 1024 || port > 65535) {
    return {
      ok: false,
      error: "redirect_port must be between 1024 and 65535.",
    };
  }
  const state = params.get("state") ?? "";
  if (state.length === 0) {
    return { ok: false, error: "Missing state parameter." };
  }
  const name = params.get("name")?.trim() || "unknown device";
  return { ok: true, request: { port, state, name } };
}

export function buildCallbackUrl(
  port: number,
  args: { token: string; tokenId: string; state: string },
): string {
  const query = new URLSearchParams({
    token: args.token,
    tokenId: args.tokenId,
    state: args.state,
  });
  return `http://127.0.0.1:${port}/callback?${query.toString()}`;
}
