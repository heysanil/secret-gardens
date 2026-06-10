import { expect, test } from "bun:test";
import { CLI_VERSION } from "./index";

test("exports a semver-shaped version", () => {
  expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
