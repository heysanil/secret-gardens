import {
  loadMasterKey,
  type MasterKey,
  MasterKeyError,
} from "@secret-gardens/crypto";

/** Thrown for any invalid or missing configuration. Never echoes env values. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  port: number;
  publicUrl: string;
  redisUrl: string;
  dbPath: string;
  masterKey: MasterKey;
  /** better-auth signing secret (BETTER_AUTH_SECRET). Never log or echo. */
  authSecret: string;
  /** GitHub OAuth credentials; null = provider disabled. */
  github: OAuthProviderConfig | null;
  /** Google OAuth credentials; null = provider disabled. */
  google: OAuthProviderConfig | null;
  /**
   * Extra trusted origins for better-auth (GARDENS_ADDITIONAL_ORIGINS,
   * comma-separated absolute http(s) URLs) — e.g. the Vite dev server
   * (http://localhost:5173) during development.
   */
  additionalOrigins: string[];
  /** XADD MAXLEN ~ threshold for audit streams; null = untrimmed. */
  auditMaxLen: number | null;
  /**
   * Directory containing the built web UI (GARDENS_WEB_DIST). When set, the
   * API serves it at / with an SPA fallback; null (the default) disables
   * static serving entirely (development — Vite serves the web app).
   */
  webDistPath: string | null;
}

const DEFAULT_PORT = 3000;
const DEFAULT_REDIS_URL = "redis://localhost:6379";
const DEFAULT_DB_PATH = "./data/gardens.db";
const DEFAULT_PUBLIC_URL = "http://localhost:3000";

const MIN_AUTH_SECRET_LENGTH = 32;

const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

function parsePositiveInt(raw: string, name: string): number {
  // Never include `raw` in the message — config errors must not echo values.
  if (!POSITIVE_INT_RE.test(raw)) {
    throw new ConfigError(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ConfigError(`${name} is too large to be a safe integer`);
  }
  return value;
}

/**
 * Parses a both-or-neither OAuth credential pair. Returns null when neither
 * half is set; throws when only one half is configured.
 */
function parseOAuthPair(
  idName: string,
  id: string | undefined,
  secretName: string,
  secret: string | undefined,
): OAuthProviderConfig | null {
  if (id === undefined && secret === undefined) {
    return null;
  }
  if (id === undefined || secret === undefined) {
    throw new ConfigError(
      `${idName} and ${secretName} must be configured together ` +
        "(set both to enable the provider, or neither to disable it)",
    );
  }
  return { clientId: id, clientSecret: secret };
}

/**
 * Parses GARDENS_ADDITIONAL_ORIGINS: a comma-separated list of absolute
 * http(s) URLs, each normalized to its origin. Empty/absent → [].
 */
function parseAdditionalOrigins(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  const origins: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") {
      continue;
    }
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new ConfigError(
        "GARDENS_ADDITIONAL_ORIGINS must be a comma-separated list of absolute " +
          "http(s) URLs (e.g. http://localhost:5173)",
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConfigError(
        "GARDENS_ADDITIONAL_ORIGINS entries must use http or https",
      );
    }
    origins.push(url.origin);
  }
  return origins;
}

/**
 * Validates and loads runtime configuration from an env-shaped record.
 * Fails fast with precise messages; never echoes secret values.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const portRaw = env.PORT;
  const port =
    portRaw === undefined ? DEFAULT_PORT : parsePositiveInt(portRaw, "PORT");
  if (port > 65535) {
    throw new ConfigError("PORT must be at most 65535");
  }

  const auditMaxLenRaw = env.GARDENS_AUDIT_MAXLEN;
  const auditMaxLen =
    auditMaxLenRaw === undefined
      ? null
      : parsePositiveInt(auditMaxLenRaw, "GARDENS_AUDIT_MAXLEN");

  let masterKey: MasterKey;
  try {
    masterKey = loadMasterKey(env.GARDENS_MASTER_KEY);
  } catch (err) {
    if (err instanceof MasterKeyError) {
      // loadMasterKey messages describe the problem without echoing the value.
      throw new ConfigError(
        `GARDENS_MASTER_KEY is invalid: ${err.message}. ` +
          "Run scripts/setup.sh to generate a valid key.",
      );
    }
    throw err;
  }

  // Never echo the secret (or its length) in the error message.
  const authSecret = env.BETTER_AUTH_SECRET;
  if (authSecret === undefined || authSecret.length < MIN_AUTH_SECRET_LENGTH) {
    throw new ConfigError(
      `BETTER_AUTH_SECRET is missing or shorter than ${MIN_AUTH_SECRET_LENGTH} characters. ` +
        "Run scripts/setup.sh to generate a valid secret.",
    );
  }

  const github = parseOAuthPair(
    "GITHUB_CLIENT_ID",
    env.GITHUB_CLIENT_ID,
    "GITHUB_CLIENT_SECRET",
    env.GITHUB_CLIENT_SECRET,
  );
  const google = parseOAuthPair(
    "GOOGLE_CLIENT_ID",
    env.GOOGLE_CLIENT_ID,
    "GOOGLE_CLIENT_SECRET",
    env.GOOGLE_CLIENT_SECRET,
  );

  return {
    port,
    publicUrl: env.GARDENS_PUBLIC_URL ?? DEFAULT_PUBLIC_URL,
    redisUrl: env.REDIS_URL ?? DEFAULT_REDIS_URL,
    dbPath: env.GARDENS_DB_PATH ?? DEFAULT_DB_PATH,
    masterKey,
    authSecret,
    github,
    google,
    additionalOrigins: parseAdditionalOrigins(env.GARDENS_ADDITIONAL_ORIGINS),
    auditMaxLen,
    webDistPath:
      env.GARDENS_WEB_DIST === undefined || env.GARDENS_WEB_DIST === ""
        ? null
        : env.GARDENS_WEB_DIST,
  };
}
