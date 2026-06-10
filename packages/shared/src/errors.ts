/** Thrown by parseSafeConfig when .safe.json is malformed or invalid. */
export class SafeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeConfigError";
  }
}
