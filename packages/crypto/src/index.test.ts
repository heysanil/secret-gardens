import { expect, test } from "bun:test";
import { CRYPTO_PACKAGE_NAME } from "./index";

test("exports the package name", () => {
  expect(CRYPTO_PACKAGE_NAME).toBe("@safe/crypto");
});
