/**
 * bun:test preload — fails fast (with an actionable message) when the
 * integration-test Redis from compose.test.yml is not reachable. Same
 * convention as apps/api; the CLI integration suite boots the real API
 * against this Redis.
 */
import { RedisClient } from "bun";
import { TEST_REDIS_URL } from "./testRedis";

const client = new RedisClient(TEST_REDIS_URL, {
  connectionTimeout: 2000,
  autoReconnect: false,
  maxRetries: 0,
  enableOfflineQueue: false,
});

try {
  await client.connect();
  await client.ping();
} catch {
  console.error(
    "Test Redis is not running — start it with: docker compose -f compose.test.yml up -d",
  );
  process.exit(1);
} finally {
  client.close();
}
