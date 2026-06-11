import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_URL = "http://localhost:3179";

export const E2E_DIR = join(fileURLToPath(import.meta.url), "..", "..");

/** Owner session saved by 01-setup.spec and reused by later spec files. */
export const OWNER_STATE = join(E2E_DIR, ".auth", "owner.json");

/** The first (and only self-served) signup — becomes the instance owner. */
export const OWNER = {
  name: "E2E Owner",
  email: "owner@e2e.test",
  password: "owner-password-123!",
} as const;

/** Password used for users the owner creates via the admin API. */
export const MEMBER_PASSWORD = "member-password-123!";

/** Unique, slug-safe suffix so each spec file owns its own projects/users. */
export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Mirror of the app's slug derivation, for predicting project slugs. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}
