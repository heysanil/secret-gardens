import { expect, test } from "bun:test";
import { API_NAME } from "./index";

test("exports the app name", () => {
  expect(API_NAME).toBe("@safe/api");
});
