/**
 * Centralized resolution rules (the only place precedence lives):
 *
 *   host:  --host flag → .gardens.json host → GARDENS_HOST env → credentials
 *          defaultHost → error
 *   token: GARDENS_TOKEN env (user or service) → credentials.hosts[host].token
 *          → error
 *   .gardens.json: walked UP from cwd (like git) until the filesystem root
 *   env:   -e flag (slug) → .gardens.json defaultEnvironment → error; the slug
 *          maps to an envId via GET /api/projects/:projectId (which the API
 *          filters for service tokens, so scoped tokens only ever see — and
 *          can only name — their allowed environments)
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type ApiClient, createApiClient } from "@secret-gardens/api-client";
import {
  GARDENS_CONFIG_FILENAME,
  type GardensConfig,
  GardensConfigError,
  parseGardensConfig,
} from "@secret-gardens/shared";
import { call } from "./api";
import { type CredentialsFile, type Env, readCredentials } from "./credentials";
import { CliError } from "./errors";

export interface DiscoveredConfig {
  config: GardensConfig;
  /** Absolute path of the .gardens.json that was found. */
  path: string;
}

/** Validates an http(s) URL and strips trailing slashes. */
export function normalizeHost(raw: string, source: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(
      `${source}: "${raw}" is not a valid URL — expected e.g. https://gardens.example.com`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(`${source}: "${raw}" must be an http(s) URL`);
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Walks up from `cwd` to the filesystem root looking for .gardens.json. A
 * malformed file is an error (with its path) rather than "keep walking" —
 * silently skipping it would run commands against a different project.
 */
export function discoverGardensConfig(cwd: string): DiscoveredConfig | null {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, GARDENS_CONFIG_FILENAME);
    let raw: string | null = null;
    try {
      raw = readFileSync(candidate, "utf8");
    } catch {
      // Missing/unreadable here — keep walking up.
    }
    if (raw !== null) {
      try {
        return { config: parseGardensConfig(raw), path: candidate };
      } catch (err) {
        if (err instanceof GardensConfigError) {
          throw new CliError(`${candidate}: ${err.message}`);
        }
        throw err;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export interface ResolveHostOptions {
  flagHost?: string | undefined;
  config?: GardensConfig | null;
  env?: Env;
  credentials?: CredentialsFile;
}

export function resolveHost(opts: ResolveHostOptions): string {
  if (opts.flagHost !== undefined && opts.flagHost !== "") {
    return normalizeHost(opts.flagHost, "--host");
  }
  if (opts.config != null) {
    return normalizeHost(opts.config.host, GARDENS_CONFIG_FILENAME);
  }
  const envHost = opts.env?.GARDENS_HOST;
  if (envHost !== undefined && envHost !== "") {
    return normalizeHost(envHost, "GARDENS_HOST");
  }
  const defaultHost = opts.credentials?.defaultHost;
  if (defaultHost !== undefined) {
    return defaultHost;
  }
  throw new CliError(
    "No secret-gardens host configured — run `gardens login --host <url>` or pass --host.",
  );
}

export interface ResolveTokenOptions {
  host: string;
  env?: Env;
  credentials: CredentialsFile;
}

export function resolveToken(opts: ResolveTokenOptions): string {
  const envToken = opts.env?.GARDENS_TOKEN;
  if (envToken !== undefined && envToken !== "") {
    return envToken;
  }
  const entry = opts.credentials.hosts[opts.host];
  if (entry !== undefined) {
    return entry.token;
  }
  throw new CliError(
    `Not authenticated for ${opts.host} — run \`gardens login\` or set GARDENS_TOKEN.`,
  );
}

export function resolveEnvSlug(
  flagEnv: string | undefined,
  config: GardensConfig | null,
): string {
  if (flagEnv !== undefined && flagEnv !== "") {
    return flagEnv;
  }
  if (config !== null) {
    return config.defaultEnvironment;
  }
  throw new CliError(
    "No environment specified — pass -e <env> or run `gardens init` to set a default.",
  );
}

export interface CommandContext {
  host: string;
  token: string;
  client: ApiClient;
  config: DiscoveredConfig | null;
  env: Env;
}

export interface CreateContextOptions {
  flagHost?: string | undefined;
  cwd?: string;
  env?: Env;
}

/** Resolves host + token (per the rules above) and builds a Bearer client. */
export function createCommandContext(
  opts: CreateContextOptions = {},
): CommandContext {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const config = discoverGardensConfig(cwd);
  const credentials = readCredentials(env);
  const host = resolveHost({
    flagHost: opts.flagHost,
    config: config?.config ?? null,
    env,
    credentials,
  });
  const token = resolveToken({ host, env, credentials });
  const client = createApiClient({ baseUrl: host, token });
  return { host, token, client, config, env };
}

/** Throws unless a .gardens.json was discovered. */
export function requireProjectConfig(ctx: CommandContext): DiscoveredConfig {
  if (ctx.config === null) {
    throw new CliError(
      `No ${GARDENS_CONFIG_FILENAME} found in this or any parent directory — run \`gardens init\` first.`,
    );
  }
  return ctx.config;
}

export interface ResolvedEnvironment {
  envId: string;
  envSlug: string;
}

/**
 * Maps an environment slug to its id via the project detail endpoint (works
 * for service tokens too — their detail is filtered to allowed envs, so an
 * out-of-scope slug fails here with the allowed list).
 */
export async function resolveEnvironment(
  ctx: CommandContext,
  projectId: string,
  envSlug: string,
): Promise<ResolvedEnvironment> {
  const detail = await call(
    ctx.host,
    ctx.client.api.projects({ projectId }).get(),
    {
      notFound: `Project not found or no access — check "projectId" in ${GARDENS_CONFIG_FILENAME} and your token.`,
    },
  );
  const environments = detail.environments;
  const found = environments.find((env) => env.slug === envSlug);
  if (found === undefined) {
    const available = environments.map((env) => env.slug).join(", ");
    throw new CliError(
      `Environment "${envSlug}" not found in this project${
        available === "" ? "" : ` — available environments: ${available}`
      }. (A scoped service token only sees its allowed environments.)`,
    );
  }
  return { envId: found.id, envSlug };
}

export interface SecretListEntry {
  key: string;
  version: number;
  updatedAt: number;
  updatedBy: string;
  value?: string;
}

const SECRETS_NOT_FOUND =
  "Project or environment not found, or your token has no access to it.";

/** Lists secrets (keys + metadata; values only when `includeValues`). */
export async function fetchSecrets(
  ctx: CommandContext,
  projectId: string,
  envId: string,
  opts: { includeValues: boolean },
): Promise<SecretListEntry[]> {
  const data = await call(
    ctx.host,
    ctx.client.api
      .projects({ projectId })
      .environments({ envId })
      .secrets.get(
        opts.includeValues ? { query: { include_values: "true" } } : {},
      ),
    { notFound: SECRETS_NOT_FOUND },
  );
  return data.secrets;
}

/** Decrypted secrets as a plain `{ KEY: value }` record. */
export async function fetchSecretValues(
  ctx: CommandContext,
  projectId: string,
  envId: string,
): Promise<Record<string, string>> {
  const entries = await fetchSecrets(ctx, projectId, envId, {
    includeValues: true,
  });
  const record: Record<string, string> = {};
  for (const entry of entries) {
    record[entry.key] = entry.value ?? "";
  }
  return record;
}
