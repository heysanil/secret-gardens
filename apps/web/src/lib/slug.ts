/**
 * Client-side mirror of the API's slug derivation (apps/api projects route)
 * for the live slug preview in the create-project modal. The API remains
 * the source of truth — it re-derives and validates on POST.
 */
export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function deriveProjectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}
