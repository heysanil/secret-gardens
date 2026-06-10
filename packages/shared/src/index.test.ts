import { expect, test } from "bun:test";
import { SAFE_NAME } from "./index";

test("exports the project name", () => {
  expect(SAFE_NAME).toBe("safe");
});
