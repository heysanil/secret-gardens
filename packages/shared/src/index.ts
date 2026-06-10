/**
 * Shared types, constants, the RBAC permission matrix, and the dotenv codec
 * for safe. Consumed by the API, web UI, and CLI. Zero runtime dependencies.
 */
export const SAFE_NAME = "safe" as const;

export * from "./audit";
export * from "./dotenv";
export * from "./errors";
export * from "./principals";
export * from "./roles";
export * from "./safeConfig";
export * from "./tokens";
export * from "./validation";
