import { expect, test } from "bun:test";
import { API_CLIENT_TARGET } from "./index";

test("targets the safe API", () => {
  expect(API_CLIENT_TARGET).toBe("safe");
});
