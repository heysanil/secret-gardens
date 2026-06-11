/**
 * Credentials store: `${XDG_CONFIG_HOME ?? ~/.config}/safe/credentials.json`,
 * chmod 0600, keyed by normalized host. Every function takes an env record so
 * tests never touch the real HOME.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./errors";

export type Env = Record<string, string | undefined>;

export interface HostCredentials {
  token: string;
  /** Set by the browser loopback flow; lets `safe logout` revoke by id. */
  tokenId?: string;
}

export interface CredentialsFile {
  version: 1;
  /** First login sets this; `safe logout` clears it when logging out of it. */
  defaultHost?: string;
  hosts: Record<string, HostCredentials>;
}

export function credentialsPath(env: Env = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg !== undefined && xdg !== ""
      ? xdg
      : join(env.HOME ?? homedir(), ".config");
  return join(base, "safe", "credentials.json");
}

export function emptyCredentials(): CredentialsFile {
  return { version: 1, hosts: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the credentials file; a missing file is an empty store. A corrupt
 * file is a loud, actionable error — silently treating it as empty could
 * orphan live tokens server-side.
 */
export function readCredentials(env: Env = process.env): CredentialsFile {
  const path = credentialsPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyCredentials();
    }
    throw err;
  }

  const invalid = () =>
    new CliError(
      `${path}: invalid credentials file — delete it and run \`safe login\` again.`,
    );
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.hosts)) {
    throw invalid();
  }

  const hosts: Record<string, HostCredentials> = {};
  for (const [host, entry] of Object.entries(data.hosts)) {
    if (!isRecord(entry) || typeof entry.token !== "string") {
      throw invalid();
    }
    hosts[host] = {
      token: entry.token,
      ...(typeof entry.tokenId === "string" && { tokenId: entry.tokenId }),
    };
  }
  return {
    version: 1,
    ...(typeof data.defaultHost === "string" && {
      defaultHost: data.defaultHost,
    }),
    hosts,
  };
}

/** Writes the store with 0700 dir / 0600 file permissions. Returns the path. */
export function writeCredentials(
  credentials: CredentialsFile,
  env: Env = process.env,
): string {
  const path = credentialsPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Atomic replace: write a sibling temp file, then rename over the target —
  // a crash mid-write can never leave a truncated credentials file behind.
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
  // writeFileSync's mode only applies on creation — tighten a leftover temp
  // file too; the rename then carries 0600 over any pre-existing target.
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
  return path;
}

/** Upserts a host entry; the first login ever recorded becomes defaultHost. */
export function setHostCredentials(
  host: string,
  entry: HostCredentials,
  env: Env = process.env,
): CredentialsFile {
  const credentials = readCredentials(env);
  credentials.hosts[host] = entry;
  if (credentials.defaultHost === undefined) {
    credentials.defaultHost = host;
  }
  writeCredentials(credentials, env);
  return credentials;
}

/** Removes a host entry; clears defaultHost when it pointed at that host. */
export function removeHostCredentials(
  host: string,
  env: Env = process.env,
): CredentialsFile {
  const credentials = readCredentials(env);
  delete credentials.hosts[host];
  if (credentials.defaultHost === host) {
    delete credentials.defaultHost;
  }
  writeCredentials(credentials, env);
  return credentials;
}
