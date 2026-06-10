/** URL of the integration-test Redis (compose.test.yml maps it to 6380). */
export const TEST_REDIS_URL =
  process.env.REDIS_TEST_URL ?? "redis://localhost:6380";
