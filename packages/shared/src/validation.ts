export const SECRET_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_SECRET_KEY_LENGTH = 256;
export const MAX_SECRET_VALUE_BYTES = 64 * 1024;
export const MAX_BULK_SECRETS = 1000;

const utf8 = new TextEncoder();

/** Returns null if the key is valid, otherwise a human-readable reason. */
export function validateSecretKey(key: string): string | null {
  if (key.length === 0) {
    return "Secret key must not be empty";
  }
  if (key.length > MAX_SECRET_KEY_LENGTH) {
    return `Secret key must be at most ${MAX_SECRET_KEY_LENGTH} characters (got ${key.length})`;
  }
  if (!SECRET_KEY_PATTERN.test(key)) {
    return "Secret key must start with a letter or underscore and contain only letters, digits, and underscores";
  }
  return null;
}

/** Returns null if the value is valid, otherwise a human-readable reason. */
export function validateSecretValue(value: string): string | null {
  const bytes = utf8.encode(value).length;
  if (bytes > MAX_SECRET_VALUE_BYTES) {
    return `Secret value must be at most ${MAX_SECRET_VALUE_BYTES} bytes of UTF-8 (got ${bytes})`;
  }
  return null;
}
