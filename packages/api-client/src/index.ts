/**
 * Typed Eden treaty client for the safe API.
 *
 * Thin by design: Eden's `{ data, error, status }` response shape passes
 * through untouched — no retries, no unwrapping, no error classes. Auth
 * flows under /api/auth/* are better-auth's and are NOT covered here (the
 * web app talks to them via better-auth/react).
 */
import { treaty } from "@elysiajs/eden";
import type { App } from "@safe/api";

export interface ApiClientOptions {
  /**
   * Origin of the safe API, e.g. `https://safe.example.com`. Trailing
   * slashes are normalized away.
   */
  baseUrl: string;
  /**
   * Bearer mode (CLI / service tokens) — injected as an
   * `Authorization: Bearer <token>` header on every request.
   */
  token?: string;
  /** Cookie mode (web) — passed through to fetch's `credentials` option. */
  credentials?: "include" | "omit";
  /** Custom fetch implementation — injection point for tests. */
  fetcher?: typeof fetch;
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(opts: ApiClientOptions) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  // `treaty<App>` (explicit type argument) keeps Eden's Head generic at its
  // `{}` default so per-request header typing stays untouched.
  return treaty<App>(baseUrl, {
    ...(opts.token !== undefined && {
      headers: { authorization: `Bearer ${opts.token}` },
    }),
    ...(opts.credentials !== undefined && {
      fetch: { credentials: opts.credentials },
    }),
    ...(opts.fetcher !== undefined && { fetcher: opts.fetcher }),
  });
}

export type { App } from "@safe/api";
