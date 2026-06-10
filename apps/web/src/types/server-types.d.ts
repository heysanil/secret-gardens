/**
 * Typing bridge for the Eden treaty client.
 *
 * `App` (the typed route tree) flows from apps/api source files, which are
 * written against Bun: bun:sqlite, the "bun" module, node builtins, and the
 * `Bun.password` global. The app tsconfig deliberately keeps
 * `types: ["vite/client"]` so Bun's runtime globals (Bun.serve, bun:test
 * matchers, …) stay invisible to browser code — this file registers ONLY
 * the ambient modules those server sources need to typecheck, plus a `Bun`
 * global narrowed to the password API better-auth wiring uses.
 */

/// <reference types="node" />

import "bun-types/sqlite";
import "bun-types/bun";
// Server and RedisClient augment module "bun" from separate files:
import "bun-types/serve";
import "bun-types/redis";

declare global {
  /** Narrowed Bun global — apps/api/src/auth uses Bun.password only. */
  const Bun: {
    password: typeof import("bun")["password"];
  };
}
