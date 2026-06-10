import { RedisClient } from "bun";

/**
 * The subset of Bun's RedisClient that the storage layer uses. Services and
 * tests type against this interface so failure paths can be exercised with a
 * stub without mocking a live connection.
 */
export interface RedisLike {
  connect(): Promise<void>;
  close(): void;
  /** Raw command — used for EVAL, XADD, XREVRANGE, XLEN, SCAN, UNLINK, PING. */
  send(command: string, args: string[]): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hkeys(key: string): Promise<string[]>;
}

export function createRedis(url: string): RedisClient {
  return new RedisClient(url, { autoReconnect: true });
}
