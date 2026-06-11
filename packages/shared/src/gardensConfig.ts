import { GardensConfigError } from "./errors";

export interface GardensConfig {
  host: string;
  project: string;
  projectId: string;
  defaultEnvironment: string;
}

export const GARDENS_CONFIG_FILENAME = ".gardens.json";

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

function requireNonEmptyString(
  obj: Record<string, unknown>,
  field: string,
): string {
  const value = obj[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new GardensConfigError(
      `${GARDENS_CONFIG_FILENAME}: "${field}" must be a non-empty string`,
    );
  }
  return value;
}

/**
 * Parses and validates a .gardens.json document. Unknown fields are ignored.
 * Throws GardensConfigError with a field-specific message on any problem.
 */
export function parseGardensConfig(json: string): GardensConfig {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new GardensConfigError(`${GARDENS_CONFIG_FILENAME}: invalid JSON`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new GardensConfigError(
      `${GARDENS_CONFIG_FILENAME}: must be a JSON object`,
    );
  }
  const obj = data as Record<string, unknown>;

  const host = obj.host;
  if (typeof host !== "string" || !isHttpUrl(host)) {
    throw new GardensConfigError(
      `${GARDENS_CONFIG_FILENAME}: "host" must be an http(s) URL, e.g. "https://gardens.example.com"`,
    );
  }

  return {
    host,
    project: requireNonEmptyString(obj, "project"),
    projectId: requireNonEmptyString(obj, "projectId"),
    defaultEnvironment: requireNonEmptyString(obj, "defaultEnvironment"),
  };
}
