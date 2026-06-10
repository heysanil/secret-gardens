import { expect, test } from "bun:test";
import type { App } from "./app";

/**
 * Compile-time guard for the Eden type flow: if any plugin in createApp
 * loses its typing, the App tree (or parts of it) widens to `any` and
 * api-client's treaty types silently degrade. These assertions fail tsc
 * the moment that happens.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;

type Routes = App["~Routes"];

test("App type does not widen to any and keeps its route tree", () => {
  const appIsAny: IsAny<App> = false;
  const routesAreAny: IsAny<Routes> = false;
  // Phase 5 routes are present in the typed route tree.
  const projectsTyped: Routes extends { api: { projects: unknown } }
    ? true
    : false = true;
  expect(appIsAny).toBe(false);
  expect(routesAreAny).toBe(false);
  expect(projectsTyped).toBe(true);
});
