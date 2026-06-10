const PREFIX_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Generates a prefixed id like `prj_1f0e...` (32 hex chars).
 * Ids must never contain ':' — they are embedded in Redis key paths and in
 * AES-GCM AAD strings (`projectId:envId:secretKey`), where ':' is the
 * delimiter.
 */
export function newId(prefix: string): string {
  if (!PREFIX_RE.test(prefix)) {
    throw new Error(
      `invalid id prefix "${prefix}": must match ${PREFIX_RE.source}`,
    );
  }
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
