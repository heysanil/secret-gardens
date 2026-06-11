import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { staticPlugin } from "@elysiajs/static";
import type { App } from "./app";

/**
 * Mounts the built web UI (config.webDistPath / SAFE_WEB_DIST) onto an
 * already-composed app:
 *
 * - assets are served at / via @elysiajs/static;
 * - unmatched GET/HEAD requests outside /api fall back to index.html so
 *   client-side routes (e.g. /projects/abc) deep-link correctly;
 * - /api/* always takes precedence — unknown API paths return the API's
 *   JSON 404, never HTML.
 *
 * Kept out of createApp: the plugin scans the dist directory (async IO),
 * and createApp must stay side-effect-free for tests and Eden type
 * extraction. Mutates `app` in place; the App type is unchanged.
 */
export async function mountWebDist(app: App, distPath: string): Promise<void> {
  // Read once at mount: index.html is immutable while the server runs, and
  // a missing dist fails the boot here instead of 500ing per request.
  const indexHtml = await readFile(join(distPath, "index.html"));
  // Global scope + registered BEFORE the static plugin: hooks only apply to
  // routes added after them, and the plugin's wildcard route throws
  // NOT_FOUND for unknown paths — this handler must already be in place.
  app.onError({ as: "global" }, ({ code, request, set }) => {
    if (code !== "NOT_FOUND") {
      return;
    }
    const { pathname } = new URL(request.url);
    const isApi = pathname === "/api" || pathname.startsWith("/api/");
    const isNavigation = request.method === "GET" || request.method === "HEAD";
    if (isApi || !isNavigation) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    // SPA fallback: unknown non-API paths get index.html (client routing).
    // set.status — a Response's own 200 would be overridden by the error's
    // 404 when mapped out of onError.
    set.status = 200;
    return new Response(indexHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
  app.use(
    await staticPlugin({
      assets: distPath,
      prefix: "/",
      indexHTML: true,
      // Keep the dynamic wildcard route in production too (the plugin flips
      // to per-file static routes under NODE_ENV=production): without the
      // wildcard, unknown paths bypass the NOT_FOUND error hook above and
      // the SPA fallback never fires.
      alwaysStatic: false,
    }),
  );
}
