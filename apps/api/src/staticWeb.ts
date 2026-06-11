import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { staticPlugin } from "@elysiajs/static";
import type { App } from "./app";
import type { Auth } from "./auth";

/**
 * Mounts the built web UI (config.webDistPath / GARDENS_WEB_DIST) onto an
 * already-composed app:
 *
 * - dist files are served via @elysiajs/static in `alwaysStatic` mode —
 *   one explicit GET route per file, never a `GET /*` wildcard;
 * - a single explicit `GET /*` fallback serves index.html for unmatched
 *   non-API paths (SPA deep links) and forwards unmatched /api GETs to the
 *   better-auth handler, mapping its 404 to the API's JSON not_found.
 *
 * Why the forwarding: `.mount(auth.handler)` registers an ALL /* catch-all,
 * and ANY `GET /*` route (ours or a static plugin's) beats ALL /* for GET
 * requests. A wildcard that doesn't defer to the auth handler therefore
 * breaks every GET better-auth endpoint — most fatally
 * GET /api/auth/get-session, killing all browser sessions in static mode.
 *
 * Kept out of createApp: the plugin scans the dist directory (async IO),
 * and createApp must stay side-effect-free for tests and Eden type
 * extraction. Mutates `app` in place; the App type is unchanged.
 */
export async function mountWebDist(
  app: App,
  distPath: string,
  auth: Auth,
): Promise<void> {
  // Read once at mount: index.html is immutable while the server runs, and
  // a missing dist fails the boot here instead of 500ing per request.
  const indexHtml = await readFile(join(distPath, "index.html"));

  app.use(
    await staticPlugin({
      assets: distPath,
      prefix: "/",
      indexHTML: true,
      // Explicit per-file routes only — alwaysStatic:false would register
      // the shadowing GET /* wildcard described above. The limit is the
      // plugin's static-route cutoff; past it the plugin would silently
      // register nothing, so keep it far above any realistic dist size.
      alwaysStatic: true,
      staticLimit: 65_536,
    }),
  );

  app.get("/*", async ({ request }) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      // Explicit API GET routes never reach this wildcard; what does is
      // either a mounted better-auth path (this wildcard shadows the
      // ALL /* mount for GETs) or an unknown path, which better-auth
      // answers with a 404 we translate to the API's JSON shape.
      const response = await auth.handler(
        request as unknown as Parameters<Auth["handler"]>[0],
      );
      if (response.status === 404) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return response;
    }
    // SPA fallback: unknown non-API paths get index.html (client routing).
    return new Response(indexHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
}
