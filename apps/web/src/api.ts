/**
 * API access layer: one Eden treaty client (cookie mode) plus the unwrap
 * helper every TanStack Query call goes through. 401s anywhere outside the
 * auth screens bounce to /login?next=<path>.
 */
import { createApiClient } from "@secret-gardens/api-client";

export const api = createApiClient({
  baseUrl: window.location.origin,
  credentials: "include",
});

export class ApiError extends Error {
  readonly status: number;
  /** Machine code from the API body (e.g. "last_admin"), if present. */
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const FRIENDLY: Record<string, string> = {
  unauthorized: "You need to sign in to do that.",
  forbidden: "You don't have permission to do that.",
  not_found: "That no longer exists — it may have been deleted.",
  duplicate_slug: "That slug is already taken.",
  invalid_slug:
    "Slugs must be lowercase letters, digits, and hyphens, starting with a letter or digit.",
  last_admin:
    "Every project needs at least one admin — promote someone else first.",
  already_member: "That person is already a member of this project.",
  cannot_rollback_to_delete: "You can't roll back to a deletion.",
  signup_disabled:
    "Signup is disabled on this instance. Ask an admin to invite you.",
  invalid_token: "Your credentials are no longer valid.",
  parent_token_expired:
    "Your current token is about to expire — sign in again to create new tokens.",
  decrypt_failed:
    "The server could not decrypt a secret. Check the server logs.",
};

function codeOf(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  ) {
    return (value as { error: string }).error;
  }
  return null;
}

export function friendlyMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  if (err instanceof Error && err.message.length > 0) {
    return err.message;
  }
  return "Something went wrong. Please try again.";
}

function onAuthScreen(): boolean {
  const p = window.location.pathname;
  return p === "/login" || p === "/setup";
}

function redirectToLogin(): void {
  const next = window.location.pathname + window.location.search;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

interface EdenResult<T> {
  data: T;
  error: { status: unknown; value: unknown } | null;
  status: number;
}

/**
 * Eden types some error bodies (e.g. the API's onError handlers) into the
 * `data` union; at runtime those always arrive with a 4xx/5xx status and
 * land in `error`, so the success type can safely exclude them.
 */
type ApiData<T> = Exclude<NonNullable<T>, { error: string }>;

/**
 * Awaits an Eden treaty call and unwraps `{ data, error }`: errors become
 * ApiError (with a friendly message), 401s trigger the login redirect, and
 * the success payload comes back non-null.
 */
export async function unwrap<T>(
  promise: Promise<EdenResult<T>>,
): Promise<ApiData<T>> {
  const res = await promise;
  if (res.error !== null) {
    if (res.status === 401 && !onAuthScreen()) {
      redirectToLogin();
    }
    const code = codeOf(res.error.value);
    const message =
      (code !== null ? FRIENDLY[code] : undefined) ??
      `Request failed (${res.status}${code !== null ? `: ${code}` : ""})`;
    throw new ApiError(res.status, code, message);
  }
  if (res.data === null || res.data === undefined) {
    throw new ApiError(res.status, null, "Empty response from the API");
  }
  return res.data as ApiData<T>;
}

/** Query keys, one vocabulary for the whole app. */
export const keys = {
  bootstrap: ["bootstrap"] as const,
  me: ["me"] as const,
  users: ["users"] as const,
  projects: ["projects"] as const,
  project: (projectId: string) => ["project", projectId] as const,
  secrets: (projectId: string, envId: string) =>
    ["secrets", projectId, envId] as const,
  /** Decrypted values — fetched once per env on first reveal, then cached. */
  secretValues: (projectId: string, envId: string) =>
    ["secret-values", projectId, envId] as const,
  versions: (projectId: string, envId: string, key: string, values: boolean) =>
    ["versions", projectId, envId, key, values] as const,
  members: (projectId: string) => ["members", projectId] as const,
  serviceTokens: (projectId: string) => ["service-tokens", projectId] as const,
  audit: (projectId: string, action: string, envId: string) =>
    ["audit", projectId, action, envId] as const,
  myTokens: ["my-tokens"] as const,
};
