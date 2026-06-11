import { t } from "elysia";

/**
 * Response schemas for the error statuses the auth guards
 * (auth/principal.ts) and handlers produce. Used in route `response` maps so
 * the OpenAPI spec and the Eden treaty types carry the exact error shapes.
 *
 * Guard early-returns bypass Elysia's response validation, so declaring
 * these is documentation + typing only; handler-returned statuses ARE
 * runtime-validated (see apps/api/AGENTS.md).
 */

/** 401 — no principal, or a malformed/unknown/expired/revoked Bearer token. */
export const ERROR_401 = t.Object(
  {
    error: t.Union([t.Literal("unauthorized"), t.Literal("invalid_token")]),
  },
  { description: "Missing or invalid credentials." },
);

/** 403 — authenticated but the role/scope does not allow the action. */
export const ERROR_403 = t.Object(
  { error: t.Literal("forbidden") },
  { description: "Insufficient role or token scope." },
);

/**
 * 404 — missing resource, or a project the caller may not know exists
 * (non-members and foreign service tokens get 404, never 403).
 */
export const ERROR_404 = t.Object(
  { error: t.Literal("not_found") },
  {
    description:
      "Not found — including projects the caller is not a member of " +
      "(the API never reveals which project ids exist).",
  },
);

/** 500 — a stored ciphertext failed to decrypt (mapped by onError). */
export const ERROR_500_DECRYPT = t.Object(
  { error: t.Literal("decrypt_failed") },
  {
    description:
      "A stored record failed to decrypt (GCM auth failure, unknown DEK " +
      "version, or corrupted packing). Details are in the server logs only.",
  },
);
