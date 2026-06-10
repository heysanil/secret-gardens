import { expect, test } from "bun:test";
import { appTitle } from "./title";

test("app title is safe", () => {
  expect(appTitle()).toBe("safe");
});
