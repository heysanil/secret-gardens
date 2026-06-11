/**
 * Eden call wrapper: unwraps `{ data, error, status }`, mapping transport
 * failures and API error codes onto friendly CliErrors. Secret values never
 * appear in error messages (422 details name offending KEYS only).
 */
import { CliError } from "./errors";

interface EdenError {
  status: number;
  value: unknown;
}

interface EdenResponse<T> {
  data: T;
  error: EdenError | null;
  status: number;
}

export interface CallOptions {
  /** Overrides the generic 404 message with command-specific context. */
  notFound?: string;
}

/**
 * Eden types every `status(4xx, { error })` payload into the same union as
 * the success data; at runtime those arrive via `res.error` (thrown below),
 * so the returned data can never be one of them.
 */
type ApiData<T> = Exclude<NonNullable<T>, { error: string }>;

/**
 * Awaits an Eden treaty call and returns its data, or throws a CliError with
 * a friendly message. `host` is only used for error wording.
 */
export async function call<T>(
  host: string,
  promise: Promise<EdenResponse<T>>,
  opts: CallOptions = {},
): Promise<ApiData<T>> {
  let res: EdenResponse<T>;
  try {
    res = await promise;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `Could not reach ${host} (${detail}) — check the host URL and that the server is running.`,
    );
  }
  if (res.error !== null) {
    throw apiError(host, res.error.status, res.error.value, opts);
  }
  return res.data as ApiData<T>;
}

interface ErrorBody {
  code: string | null;
  /** Offending secret keys from 422 invalid_secrets. */
  keys: string[];
  /** Offending environment ids from 422 invalid_environment_ids. */
  environmentIds: string[];
}

function parseErrorBody(value: unknown): ErrorBody {
  const body: ErrorBody = { code: null, keys: [], environmentIds: [] };
  if (typeof value !== "object" || value === null) {
    return body;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") {
    body.code = record.error;
  }
  for (const field of ["keys", "environmentIds"] as const) {
    const list = record[field];
    if (Array.isArray(list)) {
      body[field] = list.filter((k): k is string => typeof k === "string");
    }
  }
  return body;
}

/** Maps an API `{ error: code }` response onto a friendly CliError. */
export function apiError(
  host: string,
  status: number,
  value: unknown,
  opts: CallOptions = {},
): CliError {
  // Eden does not reject on transport failure: it synthesizes a 503 whose
  // `value` is the underlying fetch Error rather than an API JSON body.
  if (status === 503 && value instanceof Error) {
    return new CliError(
      `Could not reach ${host} (${value.message}) — check the host URL and that the server is running.`,
    );
  }

  const { code, keys, environmentIds } = parseErrorBody(value);

  if (code === "decrypt_failed") {
    return new CliError(
      `The server could not decrypt these secrets — its GARDENS_MASTER_KEY has likely changed. Contact the server administrator.`,
    );
  }

  switch (status) {
    case 401:
      return code === "invalid_token"
        ? new CliError(
            `Token rejected by ${host} — it may be expired or revoked. Run \`gardens login\` again or fix GARDENS_TOKEN.`,
          )
        : new CliError(
            `Not authenticated for ${host} — run \`gardens login\` or set GARDENS_TOKEN.`,
          );
    case 403:
      return new CliError(
        "Permission denied — your project role or token scope does not allow this.",
      );
    case 404:
      return new CliError(opts.notFound ?? "Not found.");
    case 422: {
      let detail = "";
      if (keys.length > 0) {
        detail = ` — offending keys: ${keys.join(", ")}`;
      } else if (environmentIds.length > 0) {
        detail = ` — offending environments: ${environmentIds.join(", ")}`;
      }
      return new CliError(
        `The server rejected the request (${code ?? "invalid request"})${detail}.`,
      );
    }
    case 500:
      return code === "internal_error"
        ? new CliError(
            `The server hit an unexpected error — try again, or check the server logs on ${host}.`,
          )
        : new CliError(`API error from ${host} (HTTP 500).`);
    default:
      return new CliError(
        `API error from ${host} (HTTP ${status}${code === null ? "" : `, ${code}`}).`,
      );
  }
}
