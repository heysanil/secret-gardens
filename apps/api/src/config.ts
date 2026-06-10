import { loadMasterKey, type MasterKey, MasterKeyError } from "@safe/crypto";

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
  /** XADD MAXLEN ~ threshold for audit streams; null = untrimmed. */
  auditMaxLen: number | null;
}

const DEFAULT_PORT = 3000;
const DEFAULT_REDIS_URL = "redis://localhost:6379";
const DEFAULT_DB_PATH = "./data/safe.db";
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

  const auditMaxLenRaw = env.SAFE_AUDIT_MAXLEN;
  const auditMaxLen =
    auditMaxLenRaw === undefined
      ? null
      : parsePositiveInt(auditMaxLenRaw, "SAFE_AUDIT_MAXLEN");

  let masterKey: MasterKey;
  try {
    masterKey = loadMasterKey(env.SAFE_MASTER_KEY);
  } catch (err) {
    if (err instanceof MasterKeyError) {
      // loadMasterKey messages describe the problem without echoing the value.
      throw new ConfigError(
        `SAFE_MASTER_KEY is invalid: ${err.message}. ` +
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
    publicUrl: env.SAFE_PUBLIC_URL ?? DEFAULT_PUBLIC_URL,
    redisUrl: env.REDIS_URL ?? DEFAULT_REDIS_URL,
    dbPath: env.SAFE_DB_PATH ?? DEFAULT_DB_PATH,
    masterKey,
    authSecret,
    github,
    google,
    auditMaxLen,
  };
}
